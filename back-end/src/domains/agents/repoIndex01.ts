/**
 * Index 01 (Pebble) persistence: Rose API key lookups for the webhook / MCP
 * endpoints and the setup guide's dedicated key.
 */

import { prisma } from '../../providers/database';

/** Owner of a Rose API key (Index 01 MCP auth), or null for an unknown key. */
export async function findRoseApiKeyOwner(apiKey: string): Promise<string | null> {
  const key = await prisma.roseApiKey.findUnique({ where: { apiKey }, select: { userId: true } });
  return key?.userId ?? null;
}

/** The Rose API key the Index 01 setup flow minted for this user, if any. */
export async function findIndex01ApiKey(userId: string, name: string): Promise<string | null> {
  const key = await prisma.roseApiKey.findFirst({
    where: { userId, name },
    orderBy: { createdAt: 'asc' },
    select: { apiKey: true },
  });
  return key?.apiKey ?? null;
}

export async function createIndex01ApiKey(
  userId: string,
  apiKey: string,
  name: string
): Promise<void> {
  await prisma.roseApiKey.create({ data: { userId, apiKey, name } });
}
