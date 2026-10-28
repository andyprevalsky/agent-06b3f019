/** Shared fixtures for the Tilion browser-challenge-recovery case files. */
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import type { Browser } from 'playwright';
import { DEFAULT_GEOLOCATION } from '../../providers/geoip';
import type { BrowserProxyRotationResult } from '../../providers/browser';
import type { RotationStep } from '../../providers/browser/rotation';
import type { BrowserSessionResumeDependencies } from '../../providers/browserSessionResume';

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
  TILION_MOBILE_ENABLED: undefined,
};
// Tilion mobile is off by default (not served on our account); its promoted path behind the flag.
export const TILION_MOBILE_ENV = { ...TILION_DEFAULT_ENV, TILION_MOBILE_ENABLED: 'true' };

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

/** Fake provider operations that write the row the way the real providers do. */
export function fakeProviderOperations() {
  const steps: RotationStep[] = [];
  const injected: Array<{ sessionId: string; userId: string; url: string }> = [];
  const resumedFrom: string[] = [];
  const replacements: string[] = [];
  const carriedStates: unknown[] = [];
  const closedValidation: string[] = [];
  let sequence = 0;
  const replace = async (taskId: string, provider: string, proxyTier: string | null) => {
    sequence += 1;
    const sessionId = `${provider}-replacement-${sequence}-${randomUUID()}`;
    const row = await prisma.browserSession.update({
      where: { id: taskId },
      data: {
        sessionId,
        provider,
        proxyTier,
        wsUrl: `wss://${provider}.invalid/${sequence}`,
        debugUrl: `https://${provider}.invalid/${sequence}`,
        status: 'ACTIVE',
        closedAt: null,
      },
    });
    replacements.push(sessionId);
    return {
      // Tilion accepts one CDP client: this create-time client must be closed
      // before the route answers, or the worker's attach is refused with 4409.
      validationBrowser: {
        close: async () => {
          closedValidation.push(sessionId);
        },
      } as unknown as Browser,
      provider: provider as 'kernel' | 'steel' | 'tilion',
      sessionId,
      debugUrl: row.debugUrl ?? '',
      wsUrl: row.wsUrl ?? '',
      savedUrl: row.currentUrl ?? row.startUrl ?? undefined,
      proxySource: `${provider}_${proxyTier ?? 'resume'}`,
      proxyLocation: DEFAULT_GEOLOCATION,
      profileId: null,
      profileSource: 'test',
    };
  };
  const dependencies: BrowserSessionResumeDependencies = {
    rotateProxy: async (taskId, step, options): Promise<BrowserProxyRotationResult> => {
      steps.push(step);
      carriedStates.push((options as { carriedState?: unknown } | undefined)?.carriedState);
      const before = await prisma.browserSession.findUniqueOrThrow({ where: { id: taskId } });
      const session = await replace(taskId, step.provider, step.proxyType);
      return {
        ...session,
        previousProvider: before.provider as BrowserProxyRotationResult['previousProvider'],
        recoveryAction: step.recoveryAction,
        proxyType: step.proxyType,
      };
    },
    // Resume dispatches on the persisted provider (index.ts providerForTask).
    resumeSession: async (taskId, options) => {
      carriedStates.push((options as { carriedState?: unknown } | undefined)?.carriedState);
      const row = await prisma.browserSession.findUniqueOrThrow({ where: { id: taskId } });
      resumedFrom.push(row.provider);
      return replace(taskId, row.provider, row.proxyTier);
    },
    injectUserData: async (sessionId, userId, url) => {
      injected.push({ sessionId, userId, url });
      return {
        cookies: { injected: true, cookieCount: 3, authSource: 'none', credentialRef: null },
        fingerprint: { injected: false },
      } as unknown as Awaited<ReturnType<BrowserSessionResumeDependencies['injectUserData']>>;
    },
    closeSession: async () => undefined,
    getBrowserCaptchaTelemetry: async () => null as never,
    // The fake Tilion session has ended remotely unless a case says otherwise.
    tilionSessionLive: async () => false,
  };
  return {
    dependencies,
    steps,
    injected,
    resumedFrom,
    replacements,
    closedValidation,
    carriedStates,
  };
}
