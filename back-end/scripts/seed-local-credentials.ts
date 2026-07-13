import type { Cookie, Integration, PasskeyCredential, Prisma } from '@prisma/client';

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
  upsert(args: Prisma.CookieUpsertArgs): Promise<unknown>;
};

export async function syncCookieCredentials(
  localCookie: CookieModel,
  cookies: Cookie[],
  batchSize = 500,
  onBatch?: (synced: number, total: number) => void
): Promise<number> {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new RangeError('batchSize must be a positive integer');
  }
  for (let i = 0; i < cookies.length; i += batchSize) {
    const batch = cookies.slice(i, i + batchSize);
    await Promise.all(
      batch.map((cookie) => {
        const { id, ...updateData } = cookie;
        void id;
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
        });
      })
    );
    const synced = Math.min(i + batch.length, cookies.length);
    if (synced < cookies.length) onBatch?.(synced, cookies.length);
  }
  return cookies.length;
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
