import type { Integration, PasskeyCredential, Prisma } from '@prisma/client';

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
