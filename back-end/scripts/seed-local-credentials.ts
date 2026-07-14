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

export async function syncRequiredCredentialTable<T>(
  tableName: string,
  sync: () => Promise<T>
): Promise<T> {
  try {
    return await sync();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${tableName} credential sync failed: ${message}`);
  }
}

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
  upsert(args: Prisma.CookieUpsertArgs): Promise<unknown>;
};

export async function syncCookieCredentials(
  localCookie: CookieModel,
  cookies: Cookie[]
): Promise<number> {
  const concurrency = 8;
  for (let index = 0; index < cookies.length; index += concurrency) {
    await Promise.all(
      cookies.slice(index, index + concurrency).map(async (cookie) => {
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

type BrowserOriginRecord = LocalStorageOrigin | IndexedDBOrigin | CacheStorageOrigin;

export type OriginModel<T extends BrowserOriginRecord> = {
  upsert(args: {
    where: { userId_origin: { userId: string; origin: string } };
    create: T;
    update: Omit<T, 'id'>;
  }): Promise<unknown>;
};

export async function syncOriginCredentials<T extends BrowserOriginRecord>(
  localOrigin: OriginModel<T>,
  origins: T[]
): Promise<number> {
  for (const origin of origins) {
    const { id: remoteId, ...updateData } = origin;
    void remoteId;
    await localOrigin.upsert({
      where: { userId_origin: { userId: origin.userId, origin: origin.origin } },
      create: origin,
      update: updateData,
    });
  }
  return origins.length;
}

export type BrowserPermissionModel = {
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
  for (const permission of permissions) {
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

export type BrowserPasswordModel = {
  upsert(args: {
    where: { userId_origin_username: { userId: string; origin: string; username: string } };
    create: BrowserPassword;
    update: Omit<BrowserPassword, 'id'>;
  }): Promise<unknown>;
};

export async function syncBrowserPasswordCredentials(
  localPassword: BrowserPasswordModel,
  passwords: BrowserPassword[]
): Promise<number> {
  for (const password of passwords) {
    const { id: remoteId, ...updateData } = password;
    void remoteId;
    await localPassword.upsert({
      where: {
        userId_origin_username: {
          userId: password.userId,
          origin: password.origin,
          username: password.username,
        },
      },
      create: password,
      update: updateData,
    });
  }
  return passwords.length;
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
