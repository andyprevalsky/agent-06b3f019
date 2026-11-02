/** Shared provider dependencies and options for browser resume and rotation. */
import type {
  closeSession,
  getBrowserCaptchaTelemetry,
  injectUserData,
  resumeSession,
  rotateProxy,
  BrowserProxyRotationResult,
} from '../browser';
import type { BrowserSession } from '@prisma/client';
import { prisma } from '../database';
import { browserResumeScope } from '../steel/lifecycleClaim';
import type { connectValidatedBrowser } from '../steel/sessionConnection';
import { storedBrowserProvider } from './types';
import { DEFAULT_GEOLOCATION } from '../geoip';
import { browserProviderEnabled } from './config';
import type { TilionCarriedState } from './tilion';
import type { restoreTilionBrowserState } from './tilionState';

/** Provider operations behind resume/rotate_ip, injectable for persistence tests. */
export interface BrowserSessionResumeDependencies {
  resumeSession: typeof resumeSession;
  rotateProxy: typeof rotateProxy;
  injectUserData: typeof injectUserData;
  closeSession: typeof closeSession;
  getBrowserCaptchaTelemetry: typeof getBrowserCaptchaTelemetry;
  /** Writes worker-carried state into a non-Tilion replacement (defaults to the real restore). */
  restoreCarriedState?: typeof restoreTilionBrowserState;
  /** Whether a Tilion session is still running (defaults to Tilion /status). */
  tilionSessionLive?: (sessionId: string) => Promise<boolean>;
}

/**
 * Worker-captured browser state (cookies, localStorage, IndexedDB; Playwright
 * storageState shape). Tilion admits one CDP client, so the backend never
 * harvests a live Tilion session itself: the worker's capture is the state a
 * Tilion replacement carries.
 */
export interface BrowserStateCarry {
  carriedState?: TilionCarriedState;
}

/** Provider options for a replacement; a non-literal so providers ignoring the carry still type-check. */
export function replacementOptions(carry: BrowserStateCarry) {
  const options: {
    keepValidationConnection: true;
    carriedState?: TilionCarriedState;
  } = {
    keepValidationConnection: true,
  };
  if (carry.carriedState !== undefined) options.carriedState = carry.carriedState;
  return options;
}

/** Tilion kill switch: off means no rotation step ever lands on a new Tilion session. */
export function tilionRotationAvailable(): boolean {
  return browserProviderEnabled('BROWSER_AGENT_TILION_ENABLED', true);
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('CAPTCHA telemetry request timed out')),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** Reconnect only to the exact acknowledged, still-paused native binding. */
export async function retryAcknowledgedHydration<T>(
  read: () => Promise<BrowserSession>,
  nativeId: string,
  targets: Array<{ targetId: string; urlHash: string }>,
  connect: typeof connectValidatedBrowser,
  assemble: (
    result: Awaited<ReturnType<typeof resumeSession>>,
    targets: Array<{ targetId: string; urlHash: string }>
  ) => Promise<T>
): Promise<T> {
  const current = await read();
  if (
    (current.controlState !== 'AGENT' &&
      (!current.controlLeaseExpiresAt || current.controlLeaseExpiresAt.getTime() > Date.now())) ||
    current.sessionId !== nativeId ||
    current.status !== 'PAUSED' ||
    !current.wsUrl ||
    !current.debugUrl
  )
    throw new Error('Acknowledged browser hydration transport changed');
  await browserResumeScope()!.assertOwned();
  const browser = await connect(current.wsUrl);
  if (!browser) throw new Error('Acknowledged browser hydration connection failed');
  browserResumeScope()!.hydrationTransportOpened();
  return assemble(
    {
      provider: storedBrowserProvider(current.provider),
      sessionId: nativeId,
      wsUrl: current.wsUrl,
      debugUrl: current.debugUrl,
      savedUrl: current.currentUrl ?? current.startUrl ?? undefined,
      proxySource: current.kernelProxySource ?? 'browser_use_residential_country',
      proxyLocation: DEFAULT_GEOLOCATION,
      profileId: current.providerProfileId,
      profileSource: current.providerProfileSource ?? 'session_bound',
      validationBrowser: browser,
    },
    targets
  );
}

/** A verified in-place exit rotation keeps the live browser and must not rehydrate it. */
export async function assembleRotationResponse<T>(
  taskId: string,
  result: BrowserProxyRotationResult,
  reserved: Pick<BrowserSession, 'provider' | 'sessionId' | 'contextId' | 'logicalOwnerKey'>,
  userId: string | undefined,
  restore: () => Promise<T>,
  readOnly: () => Promise<T>
): Promise<T> {
  if (
    result.provider !== 'tilion' ||
    result.previousProvider !== 'tilion' ||
    result.ipRotation?.rotated !== true ||
    result.ipRotation.freshAllocation !== true
  )
    return restore();
  const assertBinding = async () => {
    const current = await prisma.browserSession.findUnique({
      where: { id: taskId },
      include: { context: true },
    });
    if (
      reserved.provider !== 'tilion' ||
      !reserved.sessionId ||
      result.sessionId !== reserved.sessionId ||
      !current ||
      current.sessionId !== reserved.sessionId ||
      current.provider !== 'tilion' ||
      current.contextId !== reserved.contextId ||
      current.logicalOwnerKey !== reserved.logicalOwnerKey ||
      current.status !== 'ACTIVE' ||
      (userId !== undefined && current.context.userId !== userId) ||
      (current.controlState !== 'AGENT' &&
        (!current.controlLeaseExpiresAt || current.controlLeaseExpiresAt.getTime() > Date.now()))
    )
      throw new Error('Tilion in-place rotation binding changed');
  };
  await assertBinding();
  const response = await readOnly();
  await assertBinding();
  return response;
}

/** Reserve the original rotation budget and capture its exact source binding atomically. */
export async function reserveRotation(
  taskId: string,
  ownerUserId: string | null,
  currentUrl: string | undefined,
  cap: number
) {
  return await prisma.$queryRaw<
    Array<{
      proxyRotationCount: number;
      provider: string;
      sessionId: string | null;
      contextId: string;
      logicalOwnerKey: string | null;
    }>
  >`
      UPDATE "BrowserSession"
         SET "proxyRotationCount" = "proxyRotationCount" + 1,
             "currentUrl" = COALESCE(${currentUrl ?? null}::text, "currentUrl")
       WHERE "id" = ${taskId}
         AND "proxyRotationCount" < ${cap}
         AND (
           ${ownerUserId}::text IS NULL
           OR EXISTS (
             SELECT 1
               FROM "BrowserContext"
              WHERE "BrowserContext"."id" = "BrowserSession"."contextId"
                AND "BrowserContext"."userId" = ${ownerUserId}
           )
         )
      RETURNING "proxyRotationCount", "provider", "sessionId", "contextId", "logicalOwnerKey"
    `;
}
