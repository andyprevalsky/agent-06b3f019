import { prisma } from '../database';
import type { BrowserProviderName } from './types';

export async function getOrCreateBrowserContext(userId: string): Promise<string> {
  const existing = await prisma.browserContext.findUnique({ where: { userId } });
  if (existing !== null) return existing.id;

  const created = await prisma.browserContext.upsert({
    where: { userId },
    update: {},
    create: { userId },
  });
  return created.id;
}

export async function getProviderProfile(
  contextId: string,
  provider: BrowserProviderName
): Promise<string | null> {
  const profile = await prisma.browserProviderProfile.findUnique({
    where: { contextId_provider: { contextId, provider } },
  });
  if (profile !== null) return profile.profileId;

  if (provider === 'steel') {
    const context = await prisma.browserContext.findUnique({ where: { id: contextId } });
    return context?.contextId ?? null;
  }
  return null;
}

export async function rememberProviderProfile(
  contextId: string,
  provider: BrowserProviderName,
  profileId: string
): Promise<void> {
  await prisma.browserProviderProfile.upsert({
    where: { contextId_provider: { contextId, provider } },
    create: { contextId, provider, profileId },
    update: { profileId },
  });

  if (provider === 'steel') {
    await prisma.browserContext.update({
      where: { id: contextId },
      data: { contextId: profileId },
    });
  }
}
