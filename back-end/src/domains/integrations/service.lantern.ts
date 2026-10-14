import { randomUUID } from '../../providers/crypto';
import {
  checkLanternConnection,
  decodeLanternConnection,
  encodeLanternConnection,
  LanternCredentialError,
  lanternSharedUserId,
  refreshLanternConnection,
} from '../../providers/lanternCredentials';
import * as repo from './repo.lantern';

export { LanternCredentialError } from '../../providers/lanternCredentials';

export async function uploadLanternCredentials(userId: string, encryptedCredentials: unknown) {
  const connection = decodeLanternConnection(encryptedCredentials);
  if (connection.expiresAt <= Date.now())
    throw new LanternCredentialError(400, 'LANTERN_LOGIN_EXPIRED');
  await checkLanternConnection(connection);
  await repo.withLanternCredentialLock(userId, async (store) => {
    const existing = await store.find();
    if (existing !== null) {
      const old = decodeLanternConnection(
        (existing.config as { encryptedCredentials?: unknown } | null)?.encryptedCredentials
      );
      if (
        old.connectionId === connection.connectionId &&
        (old.expiresAt > connection.expiresAt || isRefreshFence(existing.failureReason))
      ) {
        throw new LanternCredentialError(409, 'LANTERN_NEW_LOGIN_REQUIRED');
      }
    }
    await store.save(encodeLanternConnection(connection));
  });
  return {
    connected: true,
    apiUrl: connection.apiUrl,
    connectionId: connection.connectionId,
    expiresAt: connection.expiresAt,
  };
}

type Integration = NonNullable<Awaited<ReturnType<typeof repo.findLanternIntegration>>>;

const CLAIM_PREFIX = 'lantern_refresh_pending:';
const CLAIM_LIFETIME_MS = 20000;
function isRefreshFence(reason: string | null) {
  return reason === 'lantern_refresh_outcome_unknown' || reason?.startsWith(CLAIM_PREFIX) === true;
}
function claimDeadline(reason: string | null) {
  if (reason?.startsWith(CLAIM_PREFIX) !== true) return 0;
  const deadline = Number(reason.slice(CLAIM_PREFIX.length).split(':')[0]);
  return Number.isSafeInteger(deadline) ? deadline : 0;
}
function pendingError(reason: string | null): never {
  if (claimDeadline(reason) > Date.now())
    throw new LanternCredentialError(503, 'LANTERN_REFRESH_IN_PROGRESS', { retryAfterSeconds: 1 });
  throw new LanternCredentialError(409, 'LANTERN_RECONNECT_REQUIRED');
}

function readConnection(row: Integration | null, allowPending = false) {
  if (row === null) throw new LanternCredentialError(404, 'LANTERN_NOT_CONNECTED');
  const pending = isRefreshFence(row.failureReason);
  if (pending && !allowPending) pendingError(row.failureReason);
  if (
    !row.isActive ||
    (pending && !allowPending) ||
    (row.status !== 'CONNECTED' && !(allowPending && pending))
  ) {
    throw new LanternCredentialError(409, 'LANTERN_RECONNECT_REQUIRED');
  }
  try {
    const config = row.config as { encryptedCredentials?: unknown } | null;
    return decodeLanternConnection(config?.encryptedCredentials);
  } catch (error) {
    if (error instanceof LanternCredentialError && error.status === 503) throw error;
    throw new LanternCredentialError(409, 'LANTERN_RECONNECT_REQUIRED');
  }
}

function tokenResult(connection: ReturnType<typeof readConnection>) {
  return {
    apiUrl: connection.apiUrl,
    accessToken: connection.token,
    expiresAt: connection.expiresAt,
    connectionId: connection.connectionId,
  };
}

// Only stale reads enter this coordination. Entries live for one refresh, not
// for a user session; PostgreSQL still serializes owners on different instances.
const staleRefreshes = new Map<
  string,
  { version: unknown; promise: Promise<ReturnType<typeof tokenResult>> }
>();

export async function getLanternToken(actorUserId: string) {
  // Selection is exclusively server-owned, never a model or request-body parameter.
  // An explicitly selected shared owner never falls back to a personal grant.
  const userId = lanternSharedUserId() ?? actorUserId;
  const row = await repo.findLanternIntegration(userId);
  const connection = readConnection(row, true);
  if (
    row?.status === 'CONNECTED' &&
    !isRefreshFence(row.failureReason) &&
    connection.expiresAt > Date.now() + 30000
  )
    return tokenResult(connection);
  const version = (row!.config as { encryptedCredentials?: unknown }).encryptedCredentials;
  const existing = staleRefreshes.get(userId);
  if (existing !== undefined && existing.version === version) return existing.promise;
  if (isRefreshFence(row!.failureReason)) pendingError(row!.failureReason);
  const refresh = refreshLanternForUser(userId).finally(() => {
    if (staleRefreshes.get(userId)?.promise === refresh) staleRefreshes.delete(userId);
  });
  staleRefreshes.set(userId, { version, promise: refresh });
  return refresh;
}

async function refreshLanternForUser(userId: string) {
  try {
    const claimed = await repo.withLanternCredentialLock(userId, async (store) => {
      const current = await store.find();
      const saved = readConnection(current);
      if (saved.expiresAt > Date.now() + 30000) return { saved, claim: null };
      const original = (current!.config as { encryptedCredentials: string }).encryptedCredentials;
      const deadline = Date.now() + CLAIM_LIFETIME_MS;
      const claim = `${CLAIM_PREFIX}${deadline}:${randomUUID()}`;
      const changed = await store.markRefreshPending(current!.id, original, claim);
      if (changed.count !== 1)
        throw new LanternCredentialError(503, 'LANTERN_CREDENTIAL_UNAVAILABLE');
      return { saved, claim, original, id: current!.id, deadline };
    });
    if (claimed.claim === null) return tokenResult(claimed.saved);
    // A delayed/ambiguous transaction commit must never dispatch after its lease.
    if (Date.now() >= claimed.deadline!) pendingError(claimed.claim);
    try {
      const refreshed = await refreshLanternConnection(claimed.saved);
      if (Date.now() >= claimed.deadline!) pendingError(null);
      const written = await repo.withLanternCredentialLock(userId, (store) =>
        store.finishRefresh(
          claimed.id!,
          claimed.original!,
          claimed.claim!,
          encodeLanternConnection(refreshed)
        )
      );
      if (written.count !== 1) throw new LanternCredentialError(409, 'LANTERN_RECONNECT_REQUIRED');
      return tokenResult(refreshed);
    } catch (error) {
      // Failure remains permanently fenced, but cannot touch a replacement grant.
      await repo
        .withLanternCredentialLock(userId, (store) =>
          store.finishRefresh(claimed.id!, claimed.original!, claimed.claim!)
        )
        .catch(() => undefined);
      throw error;
    }
  } catch (error) {
    if (error instanceof LanternCredentialError) throw error;
    throw new LanternCredentialError(503, 'LANTERN_CREDENTIAL_UNAVAILABLE');
  }
}

/** Public CRUD/list responses must never carry a Lantern credential envelope. */
export function redactLanternIntegration<T extends { name: string; config: unknown }>(row: T): T {
  return row.name === 'lantern_people' ? { ...row, config: {} } : row;
}

export async function updateLanternIntegration(
  userId: string,
  updates: { config?: unknown; status?: string; isActive?: boolean }
) {
  if (updates.config !== undefined || updates.status !== undefined)
    throw new LanternCredentialError(400, 'USE_LANTERN_CREDENTIAL_UPLOAD');
  return repo.withLanternCredentialLock(userId, async (store) => {
    const row = await store.find();
    if (row === null) throw new LanternCredentialError(404, 'LANTERN_NOT_CONNECTED');
    return redactLanternIntegration(
      updates.isActive === undefined ? row : await store.setActive(updates.isActive)
    );
  });
}

export async function deleteLanternIntegration(userId: string) {
  await repo.withLanternCredentialLock(userId, async (store) => {
    if ((await store.find()) === null)
      throw new LanternCredentialError(404, 'LANTERN_NOT_CONNECTED');
    await store.remove();
  });
}
