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
  Prisma,
  SteelSessionAuth,
} from '@prisma/client';

type PasskeyRecord = PasskeyCredential;

function rowSignature(parts: readonly unknown[]): string {
  return JSON.stringify(parts);
}

type SnapshotLookupModel<T extends { userId: string }> = {
  findMany?(args: { where: { userId: { in: string[] } } }): Promise<T[]>;
};

async function rowsNeedingContentSync<T extends { userId: string }>(
  remoteRows: T[],
  localModel: SnapshotLookupModel<T>,
  identity: (row: T) => string,
  contentMatches: (remote: T, local: T) => boolean
): Promise<T[]> {
  if (!localModel.findMany || remoteRows.length === 0) return remoteRows;
  const userIds = [...new Set(remoteRows.map((row) => row.userId))];
  const localRows = await localModel.findMany({ where: { userId: { in: userIds } } });
  const localByIdentity = new Map(localRows.map((row) => [identity(row), row]));
  return remoteRows.filter((row) => {
    const local = localByIdentity.get(identity(row));
    return !local || !contentMatches(row, local);
  });
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
    (remote, local) => cookieContent(remote) === cookieContent(local)
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
    (remote, local) => cookieBundleContent(remote) === cookieBundleContent(local)
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

type BrowserOriginRecord = LocalStorageOrigin | IndexedDBOrigin | CacheStorageOrigin;

export type OriginModel<T extends BrowserOriginRecord> = SnapshotLookupModel<T> & {
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
  const originsToSync = await rowsNeedingContentSync(
    origins,
    localOrigin,
    (origin) => rowSignature([origin.userId, origin.origin]),
    (remote, local) => remote.hash === local.hash
  );
  for (const origin of originsToSync) {
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
    where: { userId_origin_username: { userId: string; origin: string; username: string } };
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
    (password) => rowSignature([password.userId, password.origin, password.username]),
    (remote, local) => browserPasswordContent(remote) === browserPasswordContent(local)
  );
  for (const password of passwordsToSync) {
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
