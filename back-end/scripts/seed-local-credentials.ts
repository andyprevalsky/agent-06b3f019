import type {
  BrowserPassword,
  BrowserPermission,
  CacheStorageOrigin,
  Cookie,
  IndexedDBOrigin,
  Integration,
  LocalStorageOrigin,
  PasskeyCredential,
  Prisma,
} from '@prisma/client';

type PasskeyRecord = PasskeyCredential;

export type IntegrationModel = {
  upsert(args: Prisma.IntegrationUpsertArgs): Promise<Pick<Integration, 'id'>>;
};

export async function syncIntegrationCredentials(
  localIntegration: IntegrationModel,
  integrations: Integration[]
): Promise<string[]> {
  const syncedIds: string[] = [];
  for (const integration of integrations) {
    const { id: remoteId, ...updateData } = integration;
    void remoteId;
    const synced = await localIntegration.upsert({
      where: {
        userId_name: {
          userId: integration.userId,
          name: integration.name,
        },
      },
      create: integration,
      update: updateData,
      select: { id: true },
    });
    syncedIds.push(synced.id);
  }
  return syncedIds;
}

export type CookieModel = {
  upsert(args: Prisma.CookieUpsertArgs): Promise<Pick<Cookie, 'id'>>;
};

export async function syncCookies(
  localCookie: CookieModel,
  cookies: Cookie[],
  batchSize = 500
): Promise<number> {
  for (let index = 0; index < cookies.length; index += batchSize) {
    const batch = cookies.slice(index, index + batchSize);
    await Promise.all(
      batch.map((cookie) => {
        const { id: remoteId, ...updateData } = cookie;
        void remoteId;
        return localCookie.upsert({
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
          select: { id: true },
        });
      })
    );
  }
  return cookies.length;
}

async function syncInBatches<T>(
  records: T[],
  syncRecord: (record: T) => Promise<unknown>,
  batchSize: number
): Promise<number> {
  for (let index = 0; index < records.length; index += batchSize) {
    await Promise.all(records.slice(index, index + batchSize).map(syncRecord));
  }
  return records.length;
}

type LocalStorageOriginModel = {
  upsert(args: Prisma.LocalStorageOriginUpsertArgs): Promise<unknown>;
};

export async function syncLocalStorageOrigins(
  model: LocalStorageOriginModel,
  records: LocalStorageOrigin[],
  batchSize = 500
): Promise<number> {
  return syncInBatches(
    records,
    (record) => {
      const { id, ...update } = record;
      void id;
      return model.upsert({
        where: { userId_origin: { userId: record.userId, origin: record.origin } },
        create: record,
        update,
      });
    },
    batchSize
  );
}

type IndexedDBOriginModel = {
  upsert(args: Prisma.IndexedDBOriginUpsertArgs): Promise<unknown>;
};

export async function syncIndexedDBOrigins(
  model: IndexedDBOriginModel,
  records: IndexedDBOrigin[],
  batchSize = 500
): Promise<number> {
  return syncInBatches(
    records,
    (record) => {
      const { id, ...update } = record;
      void id;
      return model.upsert({
        where: { userId_origin: { userId: record.userId, origin: record.origin } },
        create: record,
        update,
      });
    },
    batchSize
  );
}

type BrowserPermissionModel = {
  upsert(args: Prisma.BrowserPermissionUpsertArgs): Promise<unknown>;
};

export async function syncBrowserPermissions(
  model: BrowserPermissionModel,
  records: BrowserPermission[],
  batchSize = 500
): Promise<number> {
  return syncInBatches(
    records,
    (record) => {
      const { id, ...update } = record;
      void id;
      return model.upsert({
        where: {
          userId_origin_permission: {
            userId: record.userId,
            origin: record.origin,
            permission: record.permission,
          },
        },
        create: record,
        update,
      });
    },
    batchSize
  );
}

type CacheStorageOriginModel = {
  upsert(args: Prisma.CacheStorageOriginUpsertArgs): Promise<unknown>;
};

export async function syncCacheStorageOrigins(
  model: CacheStorageOriginModel,
  records: CacheStorageOrigin[],
  batchSize = 500
): Promise<number> {
  return syncInBatches(
    records,
    (record) => {
      const { id, ...update } = record;
      void id;
      return model.upsert({
        where: { userId_origin: { userId: record.userId, origin: record.origin } },
        create: record,
        update,
      });
    },
    batchSize
  );
}

type BrowserPasswordModel = {
  upsert(args: Prisma.BrowserPasswordUpsertArgs): Promise<unknown>;
};

export async function syncBrowserPasswords(
  model: BrowserPasswordModel,
  records: BrowserPassword[],
  batchSize = 500
): Promise<number> {
  return syncInBatches(
    records,
    (record) => {
      const { id, ...update } = record;
      void id;
      return model.upsert({
        where: {
          userId_origin_username: {
            userId: record.userId,
            origin: record.origin,
            username: record.username,
          },
        },
        create: record,
        update,
      });
    },
    batchSize
  );
}

type PasskeyCredentialModel = {
  findMany(args: { where: { userId: string } }): Promise<PasskeyRecord[]>;
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
  userId: string
): Promise<number> {
  const passkeys = await remotePasskeyCredential.findMany({ where: { userId } });
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
