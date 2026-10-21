/** Shared fixtures for the Tilion browser-challenge-recovery case files. */
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export type RegisterTest = (name: string, run: () => Promise<void>) => void;

export async function withEnv<T>(
  values: Record<string, string | undefined>,
  run: () => Promise<T>
) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export const TILION_DEFAULT_ENV = {
  BROWSER_PROVIDER: 'tilion',
  BROWSER_AGENT_TILION_ENABLED: undefined,
  BROWSER_AGENT_BROWSER_USE_ENABLED: undefined,
  TILION_API_KEY: 'fake-tilion-key',
};

export async function seedRun(provider: string, proxyTier: string | null = null) {
  // Direct fixture rows: these cases exercise provider persistence, not HTTP auth.
  const owner = { userId: `tilion-switch-${randomUUID()}` };
  await prisma.user.create({ data: { userId: owner.userId } });
  const agent = await prisma.agent.create({
    data: { userId: owner.userId, goal: 'Test mid-run provider switch persistence' },
  });
  const context = await prisma.browserContext.create({
    data: { userId: owner.userId, contextId: null },
  });
  const session = await prisma.browserSession.create({
    data: {
      contextId: context.id,
      agentId: agent.id,
      sessionId: `${provider}-original-${randomUUID()}`,
      debugUrl: `https://${provider}.invalid/original`,
      wsUrl: `wss://${provider}.invalid/original`,
      startUrl: 'https://shop.example.com/',
      currentUrl: 'https://shop.example.com/cart',
      status: 'ACTIVE',
      provider,
      proxyTier,
    },
  });
  const cleanup = async () => {
    await prisma.browserSession.delete({ where: { id: session.id } }).catch(() => undefined);
    await prisma.browserContext.delete({ where: { id: context.id } }).catch(() => undefined);
    await prisma.agent.delete({ where: { id: agent.id } }).catch(() => undefined);
    await prisma.user.delete({ where: { userId: owner.userId } }).catch(() => undefined);
  };
  return { owner, agent, context, session, cleanup };
}
