import { Prisma } from '@prisma/client';
import type {
  BrowserPassword,
  BrowserPermission,
  CacheStorageOrigin,
  Cookie,
  CookieBundle,
  IndexedDBOrigin,
  Integration,
  LocalStorageOrigin,
  PasskeyCredential,
  SteelSessionAuth,
} from '@prisma/client';

type PasskeyRecord = PasskeyCredential;

function rowSignature(parts: readonly unknown[]): string {
  return JSON.stringify(parts);
}

type SnapshotLookupWhere = {
  userId: { in: string[] };
  /** Narrows the snapshot read to just the rows in the current page. */
  origin?: { in: string[] };
  authRealm?: { in: string[] };
  OR?: Array<Record<string, unknown>>;
};

type SnapshotLookupModel<T extends { userId: string }> = {
  findMany?(args: { where: SnapshotLookupWhere }): Promise<T[]>;
};

/**
 * The snapshot read must stay proportional to the rows being synced, not to the
 * whole table. Paging the remote side alone is not enough: an unscoped local
 * `findMany` re-materializes every already-synced blob row on every page, so
 * peak residency stays O(table) and the guest still dies.
 */
async function rowsNeedingContentSync<T extends { userId: string }>(
  remoteRows: T[],
  localModel: SnapshotLookupModel<T>,
  identity: (row: T) => string,
  contentMatches: (remote: T, local: T) => boolean,
  narrowSnapshot?: (rows: T[]) => Partial<SnapshotLookupWhere>
): Promise<T[]> {
  if (!localModel.findMany || remoteRows.length === 0) return remoteRows;
  const userIds = [...new Set(remoteRows.map((row) => row.userId))];
  const localRows = await localModel.findMany({
    where: { userId: { in: userIds }, ...(narrowSnapshot?.(remoteRows) ?? {}) },
  });
  const localByIdentity = new Map(localRows.map((row) => [identity(row), row]));
  return remoteRows.filter((row) => {
    const local = localByIdentity.get(identity(row));
    return !local || !contentMatches(row, local);
  });
}

/**
 * Read-and-write one page at a time so no blob-bearing table is ever fully
 * resident. Each page is released before the next is fetched, which keeps peak
 * heap proportional to `pageSize` instead of to the table.
 */
export async function syncPagedCredentials<T>(
  readPage: (page: { skip: number; take: number }) => Promise<T[]>,
  syncPage: (rows: T[]) => Promise<number>,
  pageSize: number
): Promise<number> {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error(`credential sync page size must be a positive integer, got ${pageSize}`);
  }
  let total = 0;
  for (let skip = 0; ; skip += pageSize) {
    const rows = await readPage({ skip, take: pageSize });
    if (rows.length === 0) break;
    total += await syncPage(rows);
    if (rows.length < pageSize) break;
  }
  return total;
}

export interface JsonTextOrigin {
  id: string;
  userId: string;
  origin: string;
  payload: string;
  hash: string;
  updatedAt: Date;
}

/**
 * Copy JSONB-bearing origin rows without deserializing their payload into a
 * JavaScript object. Postgres returns the JSONB as canonical text and accepts
 * that exact text back through a `::jsonb` parameter at the write boundary.
 *
 * A one-row page is intentional: a 13MB compressed IndexedDB JSONB value from
 * production expands to more than 3.8GB when Prisma materializes its nested
 * object graph. Row-count paging cannot bound that expansion; keeping the
 * payload as a string does.
 */
export async function syncJsonTextOrigins(
  readPage: (page: { afterId?: string; take: number }) => Promise<JsonTextOrigin[]>,
  readLocalHash: (userId: string, origin: string) => Promise<string | null>,
  writeRow: (row: JsonTextOrigin) => Promise<void>,
  pageSize: number
): Promise<number> {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error(`JSON text sync page size must be a positive integer, got ${pageSize}`);
  }

  let afterId: string | undefined;
  let total = 0;
  for (;;) {
    const rows = await readPage({ afterId, take: pageSize });
    if (rows.length === 0) break;
    if (rows.length > pageSize) {
      throw new Error(
        `JSON text sync reader returned ${rows.length} rows for page size ${pageSize}`
      );
    }

    for (const row of rows) {
      const localHash = await readLocalHash(row.userId, row.origin);
      if (localHash !== row.hash) await writeRow(row);
    }
    total += rows.length;

    const nextAfterId = rows.at(-1)?.id;
    if (nextAfterId === undefined || nextAfterId === afterId) {
      throw new Error('JSON text sync reader did not advance its id cursor');
    }
    afterId = nextAfterId;
    if (rows.length < pageSize) break;
  }
  return total;
}

function cookieContent(cookie: Cookie): string {
  return rowSignature([
    cookie.value,
    cookie.expiresUtc?.toString() ?? null,
    cookie.isSecure,
    cookie.isHttpOnly,
    cookie.creationUtc?.toString() ?? null,
    cookie.hasExpires,
    cookie.isPersistent,
    cookie.lastAccessUtc?.toString() ?? null,
    cookie.lastUpdateUtc?.toString() ?? null,
    cookie.priority,
    cookie.sameSite,
    cookie.sourcePort,
    cookie.sourceScheme,
  ]);
}

function cookieBundleContent(bundle: CookieBundle): string {
  return rowSignature([
    bundle.accountLabel,
    bundle.disabledAt?.toISOString() ?? null,
    bundle.disabledReason,
  ]);
}

function steelSessionContent(session: SteelSessionAuth): string {
  return rowSignature([
    session.authenticatedAt.toISOString(),
    session.disabledAt?.toISOString() ?? null,
    session.disabledReason,
  ]);
}

function browserPasswordContent(password: BrowserPassword): string {
  return rowSignature([
    password.encryptedPassword,
    password.dateLastUsed?.toString() ?? null,
    password.dateCreated?.toString() ?? null,
    password.browserSource,
    password.browserProfile,
    password.disabledAt?.toISOString() ?? null,
    password.disabledReason,
  ]);
}

function passkeyContent(passkey: PasskeyRecord): string {
  return rowSignature([
    passkey.authRealm,
    passkey.encryptedPrivateKey,
    passkey.userHandle,
    passkey.origin,
    passkey.browserSource,
    passkey.disabledAt?.toISOString() ?? null,
    passkey.disabledReason,
  ]);
}

/**
 * Bounded per-table retry budget. Retrying HERE rather than around the whole
 * browser-auth graph is what keeps a transient failure cheap: a flaky read on a
 * late table used to restart the entire sync, re-reading 21k cookies, 3.1k
 * bundles, 3.7k localStorage origins and a 38MB IndexedDB blob per attempt.
 * That redundant work — not the honest cost of the sync — exhausted the bench
 * live-fixture budget and left the task with no verdict at all.
 */
export const CREDENTIAL_TABLE_SYNC_ATTEMPTS = 3;

export type CredentialTableSyncOptions = {
  attempts?: number;
  /** Injected in tests so bounded backoff does not slow the suite. */
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Prisma driver errors routinely carry an EMPTY `message` and put everything
 * useful on `name`/`code`/`meta`. Reporting `err.message` alone therefore
 * produced `LocalStorage credential sync failed after 3 attempts:` with nothing
 * after the colon — a two-hour run that ended with no diagnosable evidence at
 * all. Never let a failure describe itself as the empty string.
 */
export function describeSyncError(err: unknown): string {
  if (!(err instanceof Error)) return String(err) || 'unknown non-Error failure';
  const detail = err as Error & { code?: unknown; meta?: unknown };
  const parts = [
    err.message.trim(),
    detail.code === undefined ? '' : `code=${String(detail.code)}`,
    detail.meta === undefined ? '' : `meta=${JSON.stringify(detail.meta)}`,
  ].filter(Boolean);
  if (parts.length === 0) {
    const frame = err.stack?.split('\n')[1]?.trim();
    return `${err.name} with no message${frame ? ` at ${frame}` : ''}`;
  }
  return `${err.name}: ${parts.join(' ')}`;
}

export async function syncRequiredCredentialTable<T>(
  tableName: string,
  sync: () => Promise<T>,
  options: CredentialTableSyncOptions = {}
): Promise<T> {
  const attempts = options.attempts ?? CREDENTIAL_TABLE_SYNC_ATTEMPTS;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error(`credential sync attempts must be a positive integer, got ${attempts}`);
  }
  const sleep = options.sleep ?? defaultSleep;
  let lastMessage = '';

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await sync();
    } catch (err) {
      lastMessage = describeSyncError(err);
      if (attempt < attempts) {
        console.warn(
          `  ⚠️  ${tableName} credential sync attempt ${attempt}/${attempts} failed: ${lastMessage}`
        );
        await sleep(500 * 2 ** (attempt - 1));
      }
    }
  }

  throw new Error(
    attempts === 1
      ? `${tableName} credential sync failed: ${lastMessage}`
      : `${tableName} credential sync failed after ${attempts} attempts: ${lastMessage}`
  );
}

export type IntegrationModel = {
  upsert(args: Prisma.IntegrationUpsertArgs): Promise<Pick<Integration, 'id'>>;
};

export async function syncIntegrationCredentials(
  localIntegration: IntegrationModel,
  integrations: Integration[]
): Promise<string[]> {
  // Reject before any writes: silently dropping an input would shift caller pool IDs.
  if (integrations.some((integration) => integration.name === 'lantern_people')) {
    throw new Error('Rotating Lantern credentials cannot be replicated by seed sync');
  }
  const syncedIds: string[] = [];
  for (const integration of integrations) {
    const { id: remoteId, config, ...rest } = integration;
    void remoteId;
    // Prisma writes a SQL NULL into a Json? column only as DbNull, never a bare null.
    const updateData = {
      ...rest,
      config: config === null ? Prisma.DbNull : (config as Prisma.InputJsonValue),
    };
    const synced = await localIntegration.upsert({
      where: {
        userId_name_accountId: {
          userId: integration.userId,
          name: integration.name,
          // Carry the source row's accountId so multi-account providers seed as
          // distinct rows; legacy single-account rows use "" and keep their old
          // (userId, name) identity.
          accountId: integration.accountId ?? '',
        },
      },
      // Local Integration ids are intentionally independent from production.
      // A previous sync may already own the remote id under an older natural
      // identity (for example after accountId changes). Let Postgres allocate a
      // fresh id on create so that stale row can be removed after the complete
      // production snapshot is reconciled, instead of failing on the id PK.
      create: updateData,
      update: updateData,
      select: { id: true },
    });
    syncedIds.push(synced.id);
  }
  return syncedIds;
}

export type CookieModel = SnapshotLookupModel<Cookie> & {
  upsert(args: Prisma.CookieUpsertArgs): Promise<unknown>;
};

export async function syncCookieCredentials(
  localCookie: CookieModel,
  cookies: Cookie[]
): Promise<number> {
  const cookiesToSync = await rowsNeedingContentSync(
    cookies,
    localCookie,
    (cookie) =>
      rowSignature([
        cookie.userId,
        cookie.domain,
        cookie.name,
        cookie.path,
        cookie.topFrameSiteKey,
        cookie.browserSource,
        cookie.browserProfile,
      ]),
    (remote, local) => cookieContent(remote) === cookieContent(local),
    (rows) => ({
      OR: rows.map((cookie) => ({
        domain: cookie.domain,
        name: cookie.name,
        path: cookie.path,
        topFrameSiteKey: cookie.topFrameSiteKey,
        browserSource: cookie.browserSource,
        browserProfile: cookie.browserProfile,
      })),
    })
  );
  const concurrency = 8;
  for (let index = 0; index < cookiesToSync.length; index += concurrency) {
    await Promise.all(
      cookiesToSync.slice(index, index + concurrency).map(async (cookie) => {
        const { id: remoteId, ...updateData } = cookie;
        void remoteId;
        await localCookie.upsert({
          where: {
            userId_domain_name_path_topFrameSiteKey_browserSource_browserProfile: {
              userId: cookie.userId,
              domain: cookie.domain,
              name: cookie.name,
              path: cookie.path,
              topFrameSiteKey: cookie.topFrameSiteKey,
              browserSource: cookie.browserSource,
              browserProfile: cookie.browserProfile,
            },
          },
          create: cookie,
          update: updateData,
        });
      })
    );
  }
  return cookies.length;
}

export type CookieBundleModel = SnapshotLookupModel<CookieBundle> & {
  upsert(args: Prisma.CookieBundleUpsertArgs): Promise<unknown>;
};

export async function syncCookieBundleCredentials(
  localCookieBundle: CookieBundleModel,
  bundles: CookieBundle[]
): Promise<number> {
  const bundlesToSync = await rowsNeedingContentSync(
    bundles,
    localCookieBundle,
    (bundle) =>
      rowSignature([bundle.userId, bundle.authRealm, bundle.browserSource, bundle.browserProfile]),
    (remote, local) => cookieBundleContent(remote) === cookieBundleContent(local),
    (rows) => ({ authRealm: { in: [...new Set(rows.map((row) => row.authRealm))] } })
  );
  for (const bundle of bundlesToSync) {
    const { id: remoteId, ...updateData } = bundle;
    void remoteId;
    await localCookieBundle.upsert({
      where: {
        userId_authRealm_browserSource_browserProfile: {
          userId: bundle.userId,
          authRealm: bundle.authRealm,
          browserSource: bundle.browserSource,
          browserProfile: bundle.browserProfile,
        },
      },
      create: bundle,
      update: updateData,
    });
  }
  return bundles.length;
}

export type SteelSessionAuthModel = SnapshotLookupModel<SteelSessionAuth> & {
  upsert(args: Prisma.SteelSessionAuthUpsertArgs): Promise<unknown>;
};

export async function syncSteelSessionAuthCredentials(
  localSteelSessionAuth: SteelSessionAuthModel,
  sessions: SteelSessionAuth[]
): Promise<number> {
  const sessionsToSync = await rowsNeedingContentSync(
    sessions,
    localSteelSessionAuth,
    (session) => rowSignature([session.userId, session.contextId, session.authRealm]),
    (remote, local) => steelSessionContent(remote) === steelSessionContent(local)
  );
  for (const session of sessionsToSync) {
    const { id: remoteId, ...updateData } = session;
    void remoteId;
    await localSteelSessionAuth.upsert({
      where: {
        userId_contextId_authRealm: {
          userId: session.userId,
          contextId: session.contextId,
          authRealm: session.authRealm,
        },
      },
      create: session,
      update: updateData,
    });
  }
  return sessions.length;
}

/**
 * The browser-storage tables whose payload column is an arbitrarily large JSON
 * blob, mapped to that column. These three are handled together because they
 * share one failure mode, not because they happen to look alike.
 */
export const ORIGIN_BLOB_COLUMNS = {
  LocalStorageOrigin: 'entries',
  IndexedDBOrigin: 'databases',
  CacheStorageOrigin: 'caches',
} as const;

export type OriginBlobTable = keyof typeof ORIGIN_BLOB_COLUMNS;

/**
 * Every origin column EXCEPT the blob. Reading a page of origins through this
 * projection is what keeps the read cheap: `hash` is the only field change
 * detection needs, so the payload must never ride along just to be discarded.
 */
export const ORIGIN_META_SELECT = {
  id: true,
  userId: true,
  origin: true,
  hash: true,
  updatedAt: true,
} as const;

export type OriginMetaRow = Pick<
  LocalStorageOrigin | IndexedDBOrigin | CacheStorageOrigin,
  'id' | 'userId' | 'origin' | 'hash' | 'updatedAt'
>;

/** The raw-SQL surface both seed endpoints expose (a `PrismaClient`). */
export type RawSqlClient = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
};

/** A `PrismaClient` local endpoint, which additionally pins one connection. */
export type TransactionalSqlClient = RawSqlClient & {
  $transaction<T>(
    fn: (tx: RawSqlClient) => Promise<T>,
    options?: { timeout?: number; maxWait?: number }
  ): Promise<T>;
};

/**
 * Characters of payload moved per round trip. This — not the row size — is what
 * peak memory is proportional to, so it is the whole point of the design: a row
 * ten times bigger than today's largest costs exactly the same peak.
 *
 * 4MB is large enough that every origin row in prod except the handful of giant
 * ones is a single round trip, so the common case pays no extra latency.
 */
const BLOB_CHUNK_CHARS = 4 * 1024 * 1024;

/** Chunked writes hold one connection open across several round trips. */
const BLOB_TRANSACTION_TIMEOUT_MS = 5 * 60 * 1000;

type BlobChunk = { chunk: string; chunkLength: number; totalLength: number };

/**
 * Read one window of a payload as text.
 *
 * `offset` and the returned lengths are all measured server-side in Postgres
 * CHARACTERS. JavaScript's `String.length` counts UTF-16 code units, so driving
 * the window from it would silently desynchronize on any astral-plane character
 * and splice the blob back together wrong.
 */
async function readBlobChunk(
  remote: RawSqlClient,
  table: OriginBlobTable,
  column: string,
  id: string,
  offset: number
): Promise<BlobChunk | null> {
  const rows = await remote.$queryRawUnsafe<
    Array<{ chunk: string; chunk_length: number; total_length: number }>
  >(
    `SELECT substr(payload, $2::int, $3::int) AS chunk,
            length(substr(payload, $2::int, $3::int)) AS chunk_length,
            length(payload) AS total_length
     FROM (SELECT "${column}"::text AS payload FROM "${table}" WHERE id = $1::text) source`,
    id,
    offset,
    BLOB_CHUNK_CHARS
  );
  if (rows.length === 0) return null;
  return {
    chunk: rows[0].chunk,
    chunkLength: Number(rows[0].chunk_length),
    totalLength: Number(rows[0].total_length),
  };
}

/**
 * `payload` is either a bind parameter (single-chunk rows) or a server-side
 * reassembly of the staged chunks, so the trailing parameter numbers shift.
 */
function upsertOriginSql(
  table: OriginBlobTable,
  column: string,
  payload: { expression: string; nextParam: number }
): string {
  return `INSERT INTO "${table}" (id, "userId", origin, "${column}", hash, "updatedAt")
     SELECT $1::text, $2::text, $3::text, ${payload.expression},
            $${payload.nextParam}::text, $${payload.nextParam + 1}::timestamp
     ON CONFLICT ("userId", origin) DO UPDATE SET
       "${column}" = EXCLUDED."${column}",
       hash = EXCLUDED.hash,
       "updatedAt" = EXCLUDED."updatedAt"`;
}

/**
 * Move one page of origin rows without ever letting the payload become a parsed
 * JavaScript value — or even a whole JavaScript string.
 *
 * Reading `IndexedDBOrigin` through the Prisma model returns `databases` as a
 * decoded JSON object. For the 41MB prod blob that is hundreds of thousands of
 * tiny V8 objects and strings on the read, and the whole graph re-encoded on the
 * write — measured at ~4GB RSS for a single row, which SIGKILLs a 4GB bench
 * guest with no stderr and leaves the benchmark with no verdict at all.
 *
 * So the payload is never decoded and never fully resident. It crosses as
 * `::text` in {@link BLOB_CHUNK_CHARS}-character windows and is reassembled
 * inside Postgres before `::jsonb` stores it; jsonb normalises identically on
 * both sides, so the stored value is byte-for-byte what a decoded round trip
 * produced. Peak memory is therefore a constant — one chunk — rather than a
 * multiple of the largest row, and stays a constant as prod's blobs grow.
 *
 * A row is fetched at all only after the hash comparison says it changed, so a
 * re-sync of unchanged origins transfers no payload whatsoever.
 */
export async function syncOriginBlobCredentials(
  remote: RawSqlClient,
  local: TransactionalSqlClient,
  table: OriginBlobTable,
  origins: OriginMetaRow[]
): Promise<number> {
  if (origins.length === 0) return 0;
  const column = ORIGIN_BLOB_COLUMNS[table];
  const userIds = [...new Set(origins.map((origin) => origin.userId))];
  // Scoped to this page's origins, and to the hash column only: an unscoped or
  // payload-bearing snapshot restores O(table) — or O(blob) — peak residency.
  const localRows = await local.$queryRawUnsafe<
    Array<{ userId: string; origin: string; hash: string }>
  >(
    `SELECT "userId", origin, hash FROM "${table}"
     WHERE "userId" = ANY($1::text[]) AND origin = ANY($2::text[])`,
    userIds,
    [...new Set(origins.map((origin) => origin.origin))]
  );
  const localHashes = new Map(
    localRows.map((row) => [rowSignature([row.userId, row.origin]), row.hash])
  );

  let pending = origins.filter(
    (origin) => localHashes.get(rowSignature([origin.userId, origin.origin])) !== origin.hash
  );

  while (pending.length > 0) {
    // One round trip carries as many payloads as fit the byte budget, so the
    // ~3.7k small LocalStorage origins still cost roughly one read per page
    // instead of one read per row — the redundant-round-trip cost that already
    // blew the bench live-fixture budget once. Rows past the budget come back
    // with a NULL payload and are picked up by the next pass; a row that cannot
    // fit the budget alone is streamed instead.
    const batch = await remote.$queryRawUnsafe<
      Array<{ id: string; payload_length: number; payload: string | null }>
    >(
      `SELECT id, payload_length,
              CASE WHEN running_length <= $2::bigint THEN payload END AS payload
       FROM (SELECT id, "${column}"::text AS payload,
                    length("${column}"::text) AS payload_length,
                    sum(length("${column}"::text)) OVER (ORDER BY id) AS running_length
             FROM "${table}" WHERE id = ANY($1::text[])) sized`,
      pending.map((origin) => origin.id),
      BLOB_CHUNK_CHARS
    );
    const byId = new Map(batch.map((row) => [row.id, row]));
    const deferred: OriginMetaRow[] = [];

    for (const origin of pending) {
      const row = byId.get(origin.id);
      if (!row) {
        throw new Error(
          `${table} row ${origin.id} (${origin.origin}) vanished between the page read and its ` +
            'payload read; the source database changed mid-sync'
        );
      }
      if (row.payload === null && Number(row.payload_length) <= BLOB_CHUNK_CHARS) {
        deferred.push(origin);
        continue;
      }
      if (row.payload !== null) {
        await local.$executeRawUnsafe(
          upsertOriginSql(table, column, { expression: '$4::jsonb', nextParam: 5 }),
          origin.id,
          origin.userId,
          origin.origin,
          row.payload,
          origin.hash,
          origin.updatedAt
        );
        continue;
      }
      await streamOversizedPayload(remote, local, table, column, origin);
    }

    if (deferred.length === pending.length) {
      throw new Error(
        `${table} payload batching made no progress on ${pending.length} row(s); the byte budget ` +
          'cannot be smaller than a single row that is not streamed'
      );
    }
    pending = deferred;
  }
  return origins.length;
}

/**
 * A payload too big for one round trip: stream it through a per-row temp table
 * so neither the reader nor the writer ever holds more than one chunk.
 * `ON COMMIT DROP` plus an interactive transaction (which pins a single
 * connection) means the staging table cannot outlive the row it assembles.
 */
async function streamOversizedPayload(
  remote: RawSqlClient,
  local: TransactionalSqlClient,
  table: OriginBlobTable,
  column: string,
  origin: OriginMetaRow
): Promise<void> {
  const first = await readBlobChunk(remote, table, column, origin.id, 1);
  if (first === null) {
    throw new Error(
      `${table} row ${origin.id} (${origin.origin}) vanished before its payload could be ` +
        'streamed; the source database changed mid-sync'
    );
  }
  await local.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(
        'CREATE TEMP TABLE "_seed_blob_chunks" (seq int NOT NULL, chunk text NOT NULL) ON COMMIT DROP'
      );
      let seq = 0;
      let offset = 1;
      let current: BlobChunk = first;
      for (;;) {
        await tx.$executeRawUnsafe(
          'INSERT INTO "_seed_blob_chunks" (seq, chunk) VALUES ($1::int, $2::text)',
          seq,
          current.chunk
        );
        offset += current.chunkLength;
        if (offset > current.totalLength) break;
        seq += 1;
        const next = await readBlobChunk(remote, table, column, origin.id, offset);
        if (next === null) {
          throw new Error(
            `${table} row ${origin.id} (${origin.origin}) vanished while streaming its payload; ` +
              'the source database changed mid-sync'
          );
        }
        current = next;
      }
      await tx.$executeRawUnsafe(
        upsertOriginSql(table, column, {
          expression:
            '(SELECT string_agg(chunk, \'\' ORDER BY seq) FROM "_seed_blob_chunks")::jsonb',
          nextParam: 4,
        }),
        origin.id,
        origin.userId,
        origin.origin,
        origin.hash,
        origin.updatedAt
      );
    },
    { timeout: BLOB_TRANSACTION_TIMEOUT_MS, maxWait: BLOB_TRANSACTION_TIMEOUT_MS }
  );
}

export type BrowserPermissionModel = SnapshotLookupModel<BrowserPermission> & {
  upsert(args: {
    where: {
      userId_origin_permission: { userId: string; origin: string; permission: string };
    };
    create: BrowserPermission;
    update: Omit<BrowserPermission, 'id'>;
  }): Promise<unknown>;
};

export async function syncBrowserPermissionCredentials(
  localPermission: BrowserPermissionModel,
  permissions: BrowserPermission[]
): Promise<number> {
  const permissionsToSync = await rowsNeedingContentSync(
    permissions,
    localPermission,
    (permission) => rowSignature([permission.userId, permission.origin, permission.permission]),
    (remote, local) => remote.setting === local.setting
  );
  for (const permission of permissionsToSync) {
    const { id: remoteId, ...updateData } = permission;
    void remoteId;
    await localPermission.upsert({
      where: {
        userId_origin_permission: {
          userId: permission.userId,
          origin: permission.origin,
          permission: permission.permission,
        },
      },
      create: permission,
      update: updateData,
    });
  }
  return permissions.length;
}

export type BrowserPasswordModel = SnapshotLookupModel<BrowserPassword> & {
  upsert(args: {
    where: {
      userId_origin_username_browserSource_browserProfile: {
        userId: string;
        origin: string;
        username: string;
        browserSource: string;
        browserProfile: string;
      };
    };
    create: BrowserPassword;
    update: Omit<BrowserPassword, 'id'>;
  }): Promise<unknown>;
};

export async function syncBrowserPasswordCredentials(
  localPassword: BrowserPasswordModel,
  passwords: BrowserPassword[]
): Promise<number> {
  const passwordsToSync = await rowsNeedingContentSync(
    passwords,
    localPassword,
    (password) =>
      rowSignature([
        password.userId,
        password.origin,
        password.username,
        password.browserSource,
        password.browserProfile,
      ]),
    (remote, local) => browserPasswordContent(remote) === browserPasswordContent(local),
    (rows) => ({
      OR: rows.map((password) => ({
        origin: password.origin,
        username: password.username,
      })),
    })
  );
  for (const password of passwordsToSync) {
    const { id: remoteId, ...updateData } = password;
    void remoteId;
    await localPassword.upsert({
      where: {
        userId_origin_username_browserSource_browserProfile: {
          userId: password.userId,
          origin: password.origin,
          username: password.username,
          browserSource: password.browserSource,
          browserProfile: password.browserProfile,
        },
      },
      create: password,
      update: updateData,
    });
  }
  return passwords.length;
}

type PasskeyCredentialModel = {
  findMany(args: { where: Prisma.PasskeyCredentialWhereInput }): Promise<PasskeyRecord[]>;
  findUnique(args: {
    where: {
      userId_rpId_credentialId: {
        userId: string;
        rpId: string;
        credentialId: string;
      };
    };
    select: { signCount: true };
  }): Promise<{ signCount: bigint } | null>;
  upsert(args: Prisma.PasskeyCredentialUpsertArgs): Promise<unknown>;
};

export async function syncPasskeyCredentials(
  remotePasskeyCredential: PasskeyCredentialModel,
  localPasskeyCredential: PasskeyCredentialModel,
  userId: string,
  remoteWhere: Prisma.PasskeyCredentialWhereInput = { userId }
): Promise<number> {
  const passkeys = await remotePasskeyCredential.findMany({ where: remoteWhere });
  const passkeysToSync = await rowsNeedingContentSync(
    passkeys,
    localPasskeyCredential,
    (passkey) => rowSignature([passkey.userId, passkey.rpId, passkey.credentialId]),
    (remote, local) =>
      passkeyContent(remote) === passkeyContent(local) && local.signCount >= remote.signCount
  );
  await syncPasskeyCredentialRows(localPasskeyCredential, passkeysToSync);
  return passkeys.length;
}

export async function syncPasskeyCredentialRows(
  localPasskeyCredential: PasskeyCredentialModel,
  passkeys: PasskeyRecord[]
): Promise<number> {
  for (const pk of passkeys) {
    const where = {
      userId_rpId_credentialId: {
        userId: pk.userId,
        rpId: pk.rpId,
        credentialId: pk.credentialId,
      },
    };
    const existing = await localPasskeyCredential.findUnique({
      where,
      select: { signCount: true },
    });
    const { id, ...updateData } = pk;
    void id;
    const remoteSignCount = pk.signCount;
    const signCount =
      existing && existing.signCount > remoteSignCount ? existing.signCount : remoteSignCount;

    await localPasskeyCredential.upsert({
      where,
      create: pk,
      update: { ...updateData, signCount },
    });
  }
  return passkeys.length;
}
