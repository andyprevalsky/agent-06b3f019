/**
 * Gmail background sync: per-address progress, batched full syncs that resume
 * from a cursor, and incremental History API syncs.
 *
 *   cron (5 min) / OAuth connect
 *      └─ claim integration row (atomic; lastSyncAt is a lease renewed by heartbeats)
 *           └─ per connected address (own runId, own progress row, own failure)
 *                ├─ history cursor stored  ─► incremental (History API)
 *                └─ none / expired / resume ─► gmailFullSync (scan → save per batch)
 *
 * 10k rule: per address per batch O(1) writes (cursor, <=1 progress write at
 * 1/s, heartbeat at 1/min); steady-state incremental syncs write one progress
 * row per address per tick.
 */
import { IntegrationStatus, EmailProvider, MessageChannel, type Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';
import { createLogger } from '../../providers/logger';
import { fetchFullMessages, fetchGmailHistory, type ParsedEmail } from './gmailParser';
import {
  isDisconnectedGoogleCredentialError,
  upsertPersonAndMessageRecords,
} from './personMessageManager';
import {
  classifyEmailAuthFailure,
  markCredentialFailure,
  markCredentialHealthy,
  type EmailAuthFailure,
} from './emailCredentialHealth';
import { missingGoogleScopes } from '../../domains/integrations/googleScopes';
import { googleClientId, googleClientSecret } from '../../domains/integrations/config';
import { encryptGoogleToken, readGoogleToken } from '../../providers/googleCredentials';
import {
  clearFullSyncCursor,
  FULL_SYNC_BATCH_SIZE,
  readFullSyncCursor,
  runGmailFullSync,
} from './gmailFullSync';
import { toContactsToUpsert } from './gmailSync.contacts';
import {
  GmailAddressProgress,
  resolveGmailSyncDeps,
  type GmailSyncDeps,
} from './gmailSync.progress';

const log = createLogger('GmailSync');

/**
 * A SYNCING row whose lease (lastSyncAt) is older than this is treated as a
 * crashed sync and re-claimed; running syncs renew it every HEARTBEAT_INTERVAL_MS.
 */
const LEASE_STALE_MS = 10 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 60 * 1000;

// Google OAuth token endpoint
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

interface IntegrationConfig {
  provider?: string;
  historyId?: string;
  historyIds?: Record<string, string>;
  userEmail?: string;
  contacts?: number;
  messages?: number;
  [key: string]: unknown;
}

/**
 * Refresh an expired Google access token using the refresh token
 */
async function refreshGoogleAccessToken(
  refreshToken: string
): Promise<
  { ok: true; accessToken: string; expiresAt: Date } | { ok: false; failure: EmailAuthFailure }
> {
  const clientId = googleClientId();
  const clientSecret = googleClientSecret();

  if (!clientId) {
    log.error('Missing GOOGLE_CLIENT_ID');
    // Our misconfiguration, not the user's. Never ask them to reconnect for this.
    return {
      ok: false,
      failure: { state: 'sync_failed', reason: 'Email sync is misconfigured on our side.' },
    };
  }

  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      ...(clientSecret && { client_secret: clientSecret }),
    });

    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.error('Token refresh failed', {
        status: response.status,
      });
      return {
        ok: false,
        failure: classifyEmailAuthFailure({ status: response.status, body: errorText }),
      };
    }

    const json = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };

    return {
      ok: true,
      accessToken: json.access_token,
      expiresAt: new Date(Date.now() + json.expires_in * 1000),
    };
  } catch {
    log.error('Error refreshing token');
    // Network/DNS failure: transient by construction.
    return {
      ok: false,
      failure: { state: 'sync_failed', reason: 'Could not reach Google. Will retry.' },
    };
  }
}

/**
 * Get a valid access token, refreshing if necessary
 */
export async function getValidAccessToken(credential: {
  id: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes?: string[];
}): Promise<string | null> {
  if (credential.scopes !== undefined && missingGoogleScopes(credential.scopes).length > 0) {
    await markCredentialFailure(credential.id, {
      state: 'needs_reconnect',
      reason: 'Reconnect Google to grant the current permissions.',
    });
    return null;
  }
  // Check if current token is still valid (with 5 min buffer)
  if (
    credential.accessToken &&
    credential.expiresAt &&
    credential.expiresAt > new Date(Date.now() + 5 * 60 * 1000)
  ) {
    return readGoogleToken(credential.accessToken);
  }

  // Need to refresh
  if (!credential.refreshToken) {
    log.error('No refresh token available');
    await markCredentialFailure(credential.id, {
      state: 'needs_reconnect',
      reason: 'This account has no saved refresh token. Reconnect it to restore access.',
    });
    return null;
  }

  log.info('Refreshing expired access token...');
  const refreshed = await refreshGoogleAccessToken(readGoogleToken(credential.refreshToken));

  if (!refreshed.ok) {
    await markCredentialFailure(credential.id, refreshed.failure);
    return null;
  }

  // Update credential in database, clearing any prior failure: a successful
  // refresh is the authoritative signal that the account is healthy again.
  await prisma.emailIntegrationCredential.update({
    where: { id: credential.id },
    data: {
      accessToken: encryptGoogleToken(refreshed.accessToken),
      expiresAt: refreshed.expiresAt,
      state: 'connected',
      lastErrorReason: null,
    },
  });

  return refreshed.accessToken;
}

type SyncCredential = {
  id: string;
  email: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes?: string[];
  metadata: Prisma.JsonValue | null;
};

type AddressResult = { success: boolean; contacts: number; messages: number };

const FAILED: AddressResult = { success: false, contacts: 0, messages: 0 };

/** Lease renewal for a long sync: bump the row's lastSyncAt at most once a minute. */
function leaseHeartbeat(integrationId: string, deps: GmailSyncDeps): () => Promise<void> {
  let last = deps.now().getTime();
  return async () => {
    const now = deps.now();
    if (now.getTime() - last < HEARTBEAT_INTERVAL_MS) return;
    last = now.getTime();
    await prisma.integration.update({ where: { id: integrationId }, data: { lastSyncAt: now } });
  };
}

/**
 * Atomic per-key config write for one address: other addresses' cursors and
 * fields written concurrently (OAuth connect, disconnect) are never clobbered.
 */
async function recordAddressSynced(params: {
  integrationId: string;
  address: string;
  historyId: string;
  isPrimary: boolean;
  contacts: number;
  messages: number;
}): Promise<void> {
  const { integrationId, address, historyId } = params;
  await prisma.$executeRaw`
    UPDATE "Integration" SET
      "config" = jsonb_set(
        jsonb_set(
          jsonb_set(
            CASE WHEN ${params.isPrimary}
              THEN jsonb_set(COALESCE("config", '{}'::jsonb), '{historyId}', to_jsonb(${historyId}::text))
              ELSE COALESCE("config", '{}'::jsonb) END,
            '{historyIds}',
            COALESCE("config"->'historyIds', '{}'::jsonb) || jsonb_build_object(${address}::text, ${historyId}::text)
          ),
          '{contacts}',
          to_jsonb(COALESCE(("config"->>'contacts')::int, 0) + ${params.contacts}::int)
        ),
        '{messages}',
        to_jsonb(COALESCE(("config"->>'messages')::int, 0) + ${params.messages}::int)
      ),
      "lastSyncAt" = NOW(),
      "lastSuccessfulSyncAt" = NOW(),
      "status" = 'CONNECTED'::"IntegrationStatus",
      "updatedAt" = NOW()
    WHERE "id" = ${integrationId}`;
}

/** Incremental sync from a stored historyId; null when Google expired that history. */
async function runIncrementalSync(params: {
  userId: string;
  credential: SyncCredential & { email: string };
  accessToken: string;
  userEmail: string;
  historyId: string;
  progress: GmailAddressProgress;
  deps: GmailSyncDeps;
}): Promise<{ historyId: string; contacts: number; messages: number; added: number } | null> {
  const { credential, accessToken, deps, progress } = params;
  const history = await fetchGmailHistory(accessToken, params.historyId, deps.fetcher);
  if (history.newHistoryId === '') return null;
  const added = history.addedMessageIds.length;
  if (added === 0) {
    log.info('No new messages', { credentialId: credential.id });
    return { historyId: history.newHistoryId, contacts: 0, messages: 0, added };
  }
  log.info('New messages found', { credentialId: credential.id, count: added });
  await progress.report({
    state: 'syncing',
    phase: 'history',
    unit: 'messages',
    done: 0,
    total: added,
  });
  const emails: ParsedEmail[] = [];
  for (let i = 0; i < added; i += FULL_SYNC_BATCH_SIZE) {
    const ids = history.addedMessageIds.slice(i, i + FULL_SYNC_BATCH_SIZE);
    emails.push(...(await fetchFullMessages(accessToken, ids, deps.fetcher)));
  }
  // The whole new set is judged together (import detection, written-to filter).
  const contactsToUpsert = await toContactsToUpsert({
    emails,
    userEmail: params.userEmail,
    userId: params.userId,
    accountEmail: credential.email,
  });
  let contacts = 0;
  let messages = 0;
  if (contactsToUpsert.length > 0) {
    const result = await upsertPersonAndMessageRecords(
      params.userId,
      contactsToUpsert,
      `gmail-sync-${credential.id}-${progress.runId}`,
      credential.email,
      credential.id,
      undefined,
      { statsFromStoredChannel: MessageChannel.EMAIL }
    );
    contacts = result.contacts;
    messages = result.messages;
  }
  return { historyId: history.newHistoryId, contacts, messages, added };
}

/** Resolve the sender address, the stored history cursor and whether it is primary. */
async function loadAddressState(integrationId: string, credentialEmail: string) {
  const integration = await prisma.integration.findUnique({
    where: { id: integrationId },
    select: { id: true, config: true },
  });
  if (!integration) return null;
  const config = (integration.config || {}) as IntegrationConfig;
  // Per-credential historyId: config.historyIds[address]; the legacy config.historyId
  // belongs to the primary address.
  const historyId =
    config.historyIds?.[credentialEmail] ||
    (credentialEmail === config.userEmail ? config.historyId : undefined);
  return { historyId, isPrimary: credentialEmail === config.userEmail };
}

async function syncAddress(
  userId: string,
  credential: SyncCredential & { email: string },
  integrationId: string,
  progress: GmailAddressProgress,
  deps: GmailSyncDeps
): Promise<AddressResult> {
  log.info('Starting sync for address', { userId, credentialId: credential.id });
  const accessToken = await getValidAccessToken(credential);
  if (!accessToken) {
    log.error('Failed to get valid access token', { credentialId: credential.id });
    const health = await prisma.emailIntegrationCredential.findUnique({
      where: { id: credential.id },
      select: { state: true, lastErrorReason: true },
    });
    const reconnect = health?.state === 'needs_reconnect';
    await progress.report({
      state: reconnect ? 'needs_reconnect' : 'failed',
      error: health?.lastErrorReason ?? 'Could not refresh Google access',
    });
    return FAILED;
  }
  const state = await loadAddressState(integrationId, credential.email);
  if (state === null) {
    log.error('Integration not found', { integrationId });
    return FAILED;
  }
  const resuming = readFullSyncCursor(credential.metadata) !== null;
  const ctx = { userId, credential, accessToken, userEmail: credential.email, progress, deps };
  let outcome: { historyId: string; contacts: number; messages: number };
  let done: number | null = null;
  let total: number | null = null;
  let phase: 'history' | 'saving' = 'history';
  const incremental =
    state.historyId && !resuming
      ? await runIncrementalSync({ ...ctx, historyId: state.historyId })
      : null;
  if (incremental !== null) {
    outcome = incremental;
    done = incremental.added;
    total = incremental.added;
  } else {
    log.info('Performing full sync', { credentialId: credential.id, resuming });
    const full = await runGmailFullSync({
      ...ctx,
      heartbeat: leaseHeartbeat(integrationId, deps),
    });
    outcome = full;
    done = full.listed;
    total = full.total;
    phase = 'saving';
  }

  await recordAddressSynced({
    integrationId,
    address: credential.email,
    historyId: outcome.historyId,
    isPrimary: state.isPrimary,
    contacts: outcome.contacts,
    messages: outcome.messages,
  });
  await clearFullSyncCursor(credential.id);
  // A completed sync clears any prior failure. getValidAccessToken only clears
  // it when it actually refreshed; a credential whose access token was still
  // valid would otherwise stay marked failed from an earlier transient error.
  await markCredentialHealthy(credential.id);
  await progress.report({ state: 'synced', phase, unit: 'messages', done, total });
  log.info('Sync complete', {
    credentialId: credential.id,
    newContacts: outcome.contacts,
    newMessages: outcome.messages,
  });
  return { success: true, contacts: outcome.contacts, messages: outcome.messages };
}

/** One address, with its failure contained to its own progress row. */
async function syncAddressContained(
  userId: string,
  credential: SyncCredential,
  integrationId: string,
  deps: GmailSyncDeps
): Promise<AddressResult> {
  const email = credential.email ?? '';
  if (email === '') return FAILED;
  const progress = new GmailAddressProgress(userId, email, deps);
  try {
    return await syncAddress(userId, { ...credential, email }, integrationId, progress, deps);
  } catch (error) {
    log.error('Error syncing credential', {
      credentialId: credential.id,
      errorType: error instanceof Error ? error.name : 'UnknownError',
      error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
    });
    // A disconnected address has no account left to report on; writing would
    // resurrect its deleted progress row.
    if (!isDisconnectedGoogleCredentialError(error)) {
      await progress.report({ state: 'failed', error: 'Gmail sync failed' });
    }
    return FAILED;
  }
}

/**
 * Credentials awaiting re-consent are skipped (their refresh token is gone, so a
 * retry is a guaranteed 400 every tick), and so are address-less ones: an address
 * is the account, so there is nothing to report progress for.
 */
function isSyncable(c: { refreshToken: string | null; state: string; email: string | null }) {
  return Boolean(c.refreshToken) && c.state !== 'needs_reconnect' && Boolean(c.email);
}

const syncWhere = (cutoff: Date): Prisma.IntegrationWhereInput => ({
  name: 'gmail',
  isActive: true,
  OR: [
    { status: { in: [IntegrationStatus.CONNECTED, IntegrationStatus.SYNC_FAILED] } },
    { status: IntegrationStatus.SYNCING, lastSyncAt: { lt: cutoff } },
  ],
});

/**
 * Claim one integration for this run: an atomic conditional update, so the cron
 * and an OAuth-triggered sync never run the same row at once. A SYNCING row is
 * claimable only once its lease (lastSyncAt, renewed by heartbeats) went stale.
 */
async function claimIntegration(integrationId: string, deps: GmailSyncDeps): Promise<boolean> {
  const now = deps.now();
  const claimed = await prisma.integration.updateMany({
    where: { id: integrationId, ...syncWhere(new Date(now.getTime() - LEASE_STALE_MS)) },
    data: { status: IntegrationStatus.SYNCING, lastSyncAt: now },
  });
  return claimed.count === 1;
}

async function syncClaimedIntegration(
  integration: {
    id: string;
    userId: string;
    emailCredentials: Array<SyncCredential & { state: string }>;
  },
  deps: GmailSyncDeps
): Promise<boolean> {
  const validCredentials = integration.emailCredentials.filter(isSyncable);
  let allSucceeded = true;
  for (const credential of validCredentials) {
    log.info('Syncing credential', { credentialId: credential.id, integrationId: integration.id });
    const result = await syncAddressContained(integration.userId, credential, integration.id, deps);
    if (!result.success) allSucceeded = false;
  }
  if (!allSucceeded) {
    await prisma.integration.update({
      where: { id: integration.id },
      data: {
        lastFailedSyncAt: new Date(),
        status: IntegrationStatus.SYNC_FAILED,
        failureReason: 'Gmail sync failed',
      },
    });
  } else if (validCredentials.length === 0) {
    await prisma.integration.update({
      where: { id: integration.id },
      data: { status: IntegrationStatus.CONNECTED },
    });
  }
  return allSucceeded;
}

const CREDENTIAL_SELECT = {
  id: true,
  email: true,
  accessToken: true,
  refreshToken: true,
  expiresAt: true,
  scopes: true,
  metadata: true,
  state: true,
} as const;

/** Addresses in connect order, so a multi-address row syncs deterministically. */
const GMAIL_CREDENTIALS = {
  where: { provider: EmailProvider.GMAIL },
  select: CREDENTIAL_SELECT,
  orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
};

export interface GmailSyncJobOptions {
  deps?: Partial<GmailSyncDeps>;
  /** Restrict the run to these users (operator scripts and tests). */
  userIds?: string[];
}

/**
 * Run the Gmail sync job - finds all integrations due for sync and processes them
 */
export async function runGmailSyncJob(options: GmailSyncJobOptions = {}): Promise<void> {
  log.info('Starting sync job...');
  const deps = resolveGmailSyncDeps(options.deps);
  const cutoff = new Date(deps.now().getTime() - LEASE_STALE_MS);
  const dueIntegrations = await prisma.integration.findMany({
    where: {
      ...syncWhere(cutoff),
      ...(options.userIds !== undefined && { userId: { in: options.userIds } }),
    },
    select: {
      id: true,
      userId: true,
      emailCredentials: GMAIL_CREDENTIALS,
    },
  });
  log.info('Integrations due for sync', { count: dueIntegrations.length });

  let successCount = 0;
  let failCount = 0;
  for (const integration of dueIntegrations) {
    if (!integration.emailCredentials.some(isSyncable)) {
      log.info('Skipping integration - no syncable credentials', { integrationId: integration.id });
      continue;
    }
    if (!(await claimIntegration(integration.id, deps))) continue;
    if (await syncClaimedIntegration(integration, deps)) successCount++;
    else failCount++;
  }
  log.info('Sync job complete', { succeeded: successCount, failed: failCount });
}

/**
 * Start a sync of one integration now (after an OAuth connect), through the same
 * claim, per-address progress and batched full sync as the cron job. Resolves
 * false when the row is already claimed by a running sync.
 */
export async function syncGmailIntegrationNow(
  integrationId: string,
  options: { deps?: Partial<GmailSyncDeps> } = {}
): Promise<boolean> {
  const deps = resolveGmailSyncDeps(options.deps);
  if (!(await claimIntegration(integrationId, deps))) return false;
  const integration = await prisma.integration.findUnique({
    where: { id: integrationId },
    select: {
      id: true,
      userId: true,
      emailCredentials: GMAIL_CREDENTIALS,
    },
  });
  if (integration === null) return false;
  await syncClaimedIntegration(integration, deps);
  return true;
}
