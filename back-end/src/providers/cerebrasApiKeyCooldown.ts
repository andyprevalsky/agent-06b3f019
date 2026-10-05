import { prisma } from './database';

/** Provider-reported Cerebras cooldown, shared by workers using this backend.
 * Credential hashes, never API keys, identify the model-specific sentinel. */
function cerebrasCooldownIdentity(credentialId: string, model: string) {
  if (!/^[a-f0-9]{64}$/.test(credentialId) || !/^[a-zA-Z0-9._-]{1,100}$/.test(model)) {
    throw new Error('Invalid Cerebras credential identity or model');
  }
  return {
    userId: '00000000-0000-0000-0000-000000000000',
    name: 'cerebras_api_key_cooldown',
    accountId: `${credentialId}:${model}`,
  };
}

export async function getCerebrasApiKeyCooldown(credentialId: string, model: string) {
  const row = await prisma.integration.findUnique({
    where: { userId_name_accountId: cerebrasCooldownIdentity(credentialId, model) },
    select: { rateLimitedUntil: true },
  });
  return { rateLimitedUntil: row?.rateLimitedUntil?.toISOString() ?? null };
}

export async function markCerebrasApiKeyOnCooldown(
  credentialId: string,
  model: string,
  rateLimitedUntil: string
): Promise<void> {
  const identity = cerebrasCooldownIdentity(credentialId, model);
  const until = new Date(rateLimitedUntil);
  if (!Number.isFinite(until.getTime()) || until.getTime() <= Date.now()) {
    throw new Error('Cerebras cooldown must have a future provider reset time');
  }
  try {
    await prisma.integration.upsert({
      where: { userId_name_accountId: identity },
      create: { ...identity, type: 'TOOL_SETUP', status: 'NOT_CONNECTED', rateLimitedUntil: until },
      update: {},
    });
  } catch (error) {
    // Prisma can emulate an empty-update upsert; a concurrent creator may win.
    // The unique identity now exists, so continue to the atomic maximum update.
    if ((error as { code?: string }).code !== 'P2002') throw error;
  }
  // Concurrent responses must never shorten a previously reported reset.
  await prisma.integration.updateMany({
    where: { ...identity, OR: [{ rateLimitedUntil: null }, { rateLimitedUntil: { lt: until } }] },
    data: { rateLimitedUntil: until },
  });
}
