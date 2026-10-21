import { checkpointLogicalBrowser } from './checkpoint';
import { prisma } from '../database';
import { DEFAULT_GEOLOCATION, type ProxyGeoLocation } from '../geoip';
import { createLogger } from '../logger';
import {
  closeSession as closeSteelSession,
  createSessionWithContext as createSteelSessionWithContext,
  resumeSession as resumeSteelSession,
  steelApiUrl,
  steelSessionFileUrl,
} from '../steel/session';
import { getSteelCaptchaTelemetry, getSteelSessionHealth } from '../steel/sessionInspect';
import { rotateSession as rotateSteelSession } from '../steel/sessionResume';
import { getFingerprintInjectionData, listSessionFiles, uploadFileToSession } from '../steel/files';
import { injectUserData } from '../steel/injection';
import { compatiblePreferredBrowserConfig } from './challengeRecovery';
import { browserUseEnabled, selectedBrowserProvider } from './config';
import { getOrCreateBrowserContext } from './context';
import {
  closeBrowserUseSession,
  createBrowserUseSessionWithContext,
  getBrowserUseSessionHealth,
  listBrowserUseSessionFiles,
  pressBrowserUseKeys,
  readBrowserUseSessionFile,
  resumeBrowserUseSession,
  rotateBrowserUseSession,
  uploadBrowserUseSessionFile,
} from './browserUse';
import {
  captureKernelScreenshot,
  closeKernelSession,
  createKernelSessionWithContext,
  getKernelSessionHealth,
  getKernelCaptchaTelemetry,
  listKernelSessionFiles,
  pressKernelKeys,
  readKernelSessionFile,
  resizeKernelViewport,
  resumeKernelSession,
  rotateKernelSession,
  uploadKernelSessionFile,
} from './kernel';
import type { KernelProxyType } from './kernelProxy';
import type { RotationRecoveryAction, RotationStep } from './rotation';
import { persistSignedInBrowserState } from './sessionAuthPersist';
import { mergeSessionWorldState, type WorldStateMergeReceipt } from './worldState';
import { releaseSupersededBrowser } from './sessionCleanup';
import {
  storedBrowserProvider,
  type BrowserFileInfo,
  type BrowserProviderName,
  type BrowserProviderResumeSession,
  type BrowserProviderSession,
  type BrowserSessionHealth,
  type BrowserViewport,
  type BrowserViewportResizeResult,
} from './types';

export {
  BrowserProviderRateLimitError,
  type BrowserFileInfo,
  type BrowserProviderName,
  type BrowserSessionHealth,
  type BrowserViewport,
  type BrowserViewportResizeResult,
} from './types';
export { selectedBrowserProvider } from './config';
export { injectUserData, getFingerprintInjectionData };

export const getOrCreateContext = getOrCreateBrowserContext;
const PROVIDER_FETCH_TIMEOUT_MS = 15_000;
const log = createLogger('BrowserProvider');

export interface BrowserSessionCreationDependencies {
  readPreferredConfig: (contextId: string) => Promise<unknown>;
  defaultProvider: () => BrowserProviderName;
  createKernel: typeof createKernelSessionWithContext;
  createSteel: typeof createSteelSessionWithContext;
  createBrowserUse: typeof createBrowserUseSessionWithContext;
}

export interface BrowserSessionCreationOptions {
  keepValidationConnection?: boolean;
  requiredSteelProfileId?: string;
  taskId?: string;
}

const browserSessionCreationDependencies: BrowserSessionCreationDependencies = {
  readPreferredConfig: async (contextId) => {
    const context = await prisma.browserContext.findUnique({
      where: { id: contextId },
      select: { preferredBrowserConfig: true },
    });
    return context?.preferredBrowserConfig;
  },
  defaultProvider: selectedBrowserProvider,
  createKernel: createKernelSessionWithContext,
  createSteel: createSteelSessionWithContext,
  createBrowserUse: createBrowserUseSessionWithContext,
};

async function fetchProviderApi<T>(
  url: string,
  init: RequestInit,
  consume: (response: Response) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return await consume(response);
  } finally {
    clearTimeout(timeout);
  }
}

async function providerForSession(sessionId: string): Promise<BrowserProviderName> {
  const session = await prisma.browserSession.findUnique({
    where: { sessionId },
    select: { provider: true },
  });
  if (session === null) throw new Error(`Browser session not found: ${sessionId}`);
  return storedBrowserProvider(session.provider);
}

async function providerForTask(taskId: string): Promise<BrowserProviderName> {
  const session = await prisma.browserSession.findUnique({
    where: { id: taskId },
    select: { provider: true },
  });
  if (session === null) throw new Error(`Browser task not found: ${taskId}`);
  return storedBrowserProvider(session.provider);
}

export async function createSessionWithContext(
  contextId: string,
  agentId: string,
  proxyLocation: ProxyGeoLocation = DEFAULT_GEOLOCATION,
  startUrl?: string,
  options?: BrowserSessionCreationOptions
): Promise<BrowserProviderSession> {
  return createSessionWithContextUsingDependencies(
    contextId,
    agentId,
    proxyLocation,
    startUrl,
    options,
    browserSessionCreationDependencies
  );
}

/** Actual next-session preference consumer, dependency-injected for contract tests. */
export async function createSessionWithContextUsingDependencies(
  contextId: string,
  agentId: string,
  proxyLocation: ProxyGeoLocation,
  startUrl: string | undefined,
  options: BrowserSessionCreationOptions | undefined,
  dependencies: BrowserSessionCreationDependencies
): Promise<BrowserProviderSession> {
  const requiredSteelProfileId = options?.requiredSteelProfileId;
  const preferred =
    requiredSteelProfileId === undefined
      ? compatiblePreferredBrowserConfig(
          await dependencies.readPreferredConfig(contextId),
          proxyLocation
        )
      : null;
  const createForProvider = async (
    provider: BrowserProviderName,
    usePreference: typeof preferred
  ): Promise<BrowserProviderSession> => {
    if (provider === 'kernel') {
      return dependencies.createKernel(contextId, agentId, proxyLocation, startUrl, {
        ...options,
        ...(usePreference?.kernelProxyType && usePreference.kernelSpecificity
          ? {
              exactManagedProxy: {
                type: usePreference.kernelProxyType,
                specificity: usePreference.kernelSpecificity,
              },
            }
          : {}),
      });
    }
    if (provider === 'browser-use') {
      if (!browserUseEnabled()) {
        throw new Error('Browser Use is disabled by BROWSER_AGENT_BROWSER_USE_ENABLED');
      }
      return dependencies.createBrowserUse(contextId, agentId, proxyLocation, startUrl, options);
    }

    const session = await dependencies.createSteel(contextId, agentId, proxyLocation, startUrl, {
      ...options,
      ...(usePreference?.steelProxyMode ? { proxyMode: usePreference.steelProxyMode } : {}),
    });
    return {
      provider: session.sessionId.startsWith('local-') ? 'local' : 'steel',
      sessionId: session.sessionId,
      debugUrl: session.debugUrl,
      taskId: session.taskId,
      wsUrl: session.wsUrl,
      proxySource: session.proxySource,
      proxyLocation: session.proxyLocation,
      profileId: session.steelProfileId,
      profileSource: session.profileSource,
      validationBrowser: session.validationBrowser,
    };
  };

  if (requiredSteelProfileId !== undefined) {
    // SteelSessionAuth represents browser state held by one exact Steel
    // profile. Falling back to another provider/profile would falsely claim the
    // agent is authenticated, so this path is intentionally fail-closed.
    return createForProvider('steel', null);
  }

  if (preferred !== null && (preferred.provider !== 'browser-use' || browserUseEnabled())) {
    try {
      return await createForProvider(preferred.provider, preferred);
    } catch (error) {
      log.warn('Preferred browser config unavailable; falling back to deployment default', {
        contextId,
        preferredProvider: preferred.provider,
        preferredProxyMode: preferred.proxyMode,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return createForProvider(dependencies.defaultProvider(), null);
}

export async function closeSession(
  sessionId: string,
  pause = false,
  currentUrl?: string,
  worldState: { signedInSites?: string[] } = {}
): Promise<{ worldState: WorldStateMergeReceipt | null }> {
  const logical = await prisma.browserSession.findUnique({
    where: { sessionId },
    select: { id: true, logicalOwnerKey: true },
  });
  if (pause && logical?.logicalOwnerKey) await checkpointLogicalBrowser(sessionId);
  const providerPause = pause && !logical?.logicalOwnerKey;
  // A logical checkpoint is private state, not verified account evidence.
  // Legacy harvesting must not publish it into a different browser account.
  if (!logical?.logicalOwnerKey)
    await persistSignedInBrowserState(sessionId, { currentUrl }).catch((error) => {
      log.warn('Failed to persist signed-in browser state before close', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  // Root world state (A6): merge the sites this task forked while its browser
  // still exists. Best-effort and bounded; never blocks the provider release.
  const merged = logical?.logicalOwnerKey
    ? null
    : await mergeSessionWorldState(sessionId, {
        signedInSites: worldState.signedInSites,
      }).catch((error: unknown) => {
        log.warn('Failed to merge browser world state before close', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
  const provider = await providerForSession(sessionId);
  if (provider === 'kernel') {
    await closeKernelSession(sessionId, providerPause, currentUrl);
  } else if (provider === 'browser-use') {
    await closeBrowserUseSession(sessionId, providerPause, currentUrl);
  } else {
    await closeSteelSession(sessionId, providerPause, currentUrl);
  }
  if (pause && logical?.logicalOwnerKey)
    await prisma.browserSession.update({
      where: { id: logical.id },
      data: { status: 'PAUSED', closedAt: null },
    });
  return { worldState: merged };
}

export async function resumeSession(
  taskId: string,
  options: {
    forceFreshProfile?: boolean;
    keepValidationConnection?: boolean;
  } = {}
): Promise<BrowserProviderResumeSession> {
  const provider = await providerForTask(taskId);
  if (provider === 'kernel') return resumeKernelSession(taskId, options);
  if (provider === 'browser-use') {
    if (!browserUseEnabled()) {
      const previous = await prisma.browserSession.findUniqueOrThrow({
        where: { id: taskId },
        select: { sessionId: true },
      });
      const replacement = await resumeKernelSession(taskId, options);
      await releaseSupersededBrowser({
        taskId,
        previousProvider: 'browser-use',
        previousSessionId: previous.sessionId,
        operation: 'resume',
      });
      return replacement;
    }
    const { previousSessionId, previousProvider, ...session } = await resumeBrowserUseSession(
      taskId,
      options
    );
    await releaseSupersededBrowser({
      taskId,
      previousProvider,
      previousSessionId,
      operation: 'resume',
    });
    return session;
  }

  const replacement = await resumeSteelSession(taskId, options);
  const { previousSessionId, previousProvider, previousSessionReleased, ...session } = replacement;
  if (!previousSessionReleased)
    await releaseSupersededBrowser({
      taskId,
      previousProvider,
      previousSessionId,
      operation: 'resume',
    });
  return {
    ...(session.validationBrowser ? { validationBrowser: session.validationBrowser } : {}),
    provider: session.sessionId.startsWith('local-') ? 'local' : 'steel',
    debugUrl: session.debugUrl,
    sessionId: session.sessionId,
    wsUrl: session.wsUrl,
    savedUrl: session.savedUrl,
    proxySource: session.proxySource,
    proxyLocation: session.proxyLocation,
    profileId: session.steelProfileId,
    profileSource: session.profileSource,
  };
}

export class ProxyRotationUnsupportedError extends Error {
  constructor(public readonly provider: BrowserProviderName) {
    super(`Proxy rotation is not supported for the ${provider} browser provider`);
    this.name = 'ProxyRotationUnsupportedError';
  }
}

export interface BrowserProxyRotationResult extends BrowserProviderResumeSession {
  previousProvider: BrowserProviderName;
  recoveryAction: RotationRecoveryAction;
  proxyType: KernelProxyType;
}

/** Execute one server-selected rotate_ip recovery step. */
export async function rotateProxy(
  taskId: string,
  step: RotationStep,
  options: { keepValidationConnection?: boolean } = {}
): Promise<BrowserProxyRotationResult> {
  const currentProvider = await providerForTask(taskId);
  if (step.provider === 'kernel') {
    if (currentProvider !== 'kernel') throw new ProxyRotationUnsupportedError(currentProvider);
    return {
      ...(await rotateKernelSession(taskId, step.proxyType, options)),
      previousProvider: currentProvider,
      recoveryAction: step.recoveryAction,
      proxyType: step.proxyType,
    };
  }

  if (step.provider === 'browser-use') {
    if (!browserUseEnabled()) {
      throw new Error('Browser Use is disabled by BROWSER_AGENT_BROWSER_USE_ENABLED');
    }
    const { previousSessionId, previousProvider, ...session } = await rotateBrowserUseSession(
      taskId,
      options
    );
    await releaseSupersededBrowser({
      taskId,
      previousProvider,
      previousSessionId,
      operation: 'rotation',
    });
    return {
      ...session,
      previousProvider,
      recoveryAction: previousProvider === 'browser-use' ? 'ip_rotated' : 'provider_switched',
      proxyType: 'residential',
    };
  }

  const replacement = await rotateSteelSession(taskId, options);
  const { previousSessionId, previousProvider, previousSessionReleased, ...session } = replacement;
  if (!previousSessionReleased)
    await releaseSupersededBrowser({
      taskId,
      previousProvider,
      previousSessionId,
      operation: 'rotation',
    });

  return {
    ...(session.validationBrowser ? { validationBrowser: session.validationBrowser } : {}),
    provider: 'steel',
    debugUrl: session.debugUrl,
    sessionId: session.sessionId,
    wsUrl: session.wsUrl,
    savedUrl: session.savedUrl,
    proxySource: session.proxySource,
    proxyLocation: session.proxyLocation,
    profileId: session.steelProfileId,
    profileSource: session.profileSource,
    previousProvider,
    recoveryAction: previousProvider === 'kernel' ? 'provider_switched' : step.recoveryAction,
    proxyType: 'residential',
  };
}

export async function getSession(sessionId: string) {
  return prisma.browserSession.findUnique({
    where: { sessionId },
    include: { context: true },
  });
}

export async function getBrowserSessionHealth(sessionId: string): Promise<BrowserSessionHealth> {
  const provider = await providerForSession(sessionId);
  if (provider === 'kernel') return getKernelSessionHealth(sessionId);
  if (provider === 'browser-use') return getBrowserUseSessionHealth(sessionId);

  const health = await getSteelSessionHealth(sessionId);
  return { provider: 'steel', ...health };
}

/** Read provider-native CAPTCHA telemetry for the live session behind a task. */
export async function getBrowserCaptchaTelemetry(taskId: string) {
  const session = await prisma.browserSession.findUnique({
    where: { id: taskId },
    select: { provider: true, sessionId: true },
  });
  if (session === null || session.sessionId === null)
    throw new Error(`Browser task has no physical session: ${taskId}`);
  if (session.provider === 'browser-use') {
    return {
      provider: 'browser-use' as const,
      telemetryEnabled: false,
      isSolving: null,
      activeTaskCount: null,
      pages: [],
      latestOutcome: null,
    };
  }
  return session.provider === 'kernel'
    ? getKernelCaptchaTelemetry(session.sessionId)
    : getSteelCaptchaTelemetry(session.sessionId);
}

export async function resizeSessionViewport(
  sessionId: string,
  viewport: BrowserViewport,
  knownProvider?: BrowserProviderName
): Promise<BrowserViewportResizeResult> {
  const provider = knownProvider ?? (await providerForSession(sessionId));
  if (provider === 'kernel') {
    return {
      provider,
      supported: true,
      resized: true,
      viewport: await resizeKernelViewport(sessionId, viewport),
    };
  }

  return { provider, supported: false, resized: false, viewport };
}

export async function uploadSessionFile(
  sessionId: string,
  fileBuffer: Buffer,
  filename: string,
  mimeType = 'application/octet-stream',
  options: { directory?: string } = {}
): Promise<{ path: string; size: number }> {
  const provider = await providerForSession(sessionId);
  if (provider === 'browser-use') {
    return uploadBrowserUseSessionFile(sessionId, fileBuffer, filename, mimeType, options);
  }
  // Steel's Files API owns /files; directory overrides only apply to Kernel.
  return provider === 'kernel'
    ? uploadKernelSessionFile(sessionId, fileBuffer, filename, options)
    : uploadFileToSession(sessionId, fileBuffer, filename, mimeType);
}

export async function listFiles(sessionId: string): Promise<BrowserFileInfo[]> {
  const provider = await providerForSession(sessionId);
  if (provider === 'browser-use') return listBrowserUseSessionFiles(sessionId);
  return provider === 'kernel' ? listKernelSessionFiles(sessionId) : listSessionFiles(sessionId);
}

export async function readSessionFile(sessionId: string, filePath: string): Promise<Buffer> {
  const provider = await providerForSession(sessionId);
  if (provider === 'browser-use') return readBrowserUseSessionFile(sessionId, filePath);
  if (provider === 'kernel') return readKernelSessionFile(sessionId, filePath);

  const apiKey = process.env.STEEL_API_KEY?.trim();
  if (!apiKey) throw new Error('STEEL_API_KEY is required to read Steel session files');
  const relativePath = filePath.replace(/^\/files\//, '').replace(/^\//, '');
  return fetchProviderApi(
    steelSessionFileUrl(sessionId, relativePath),
    { headers: { 'steel-api-key': apiKey } },
    async (response) => {
      if (!response.ok) throw new Error(`Steel file read failed: HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    }
  );
}

export async function captureScreenshot(sessionId: string): Promise<{
  provider: BrowserProviderName;
  image: Buffer;
}> {
  const provider = await providerForSession(sessionId);
  if (provider === 'kernel') {
    return { provider, image: await captureKernelScreenshot(sessionId) };
  }
  if (provider === 'browser-use') {
    const session = await prisma.browserSession.findUniqueOrThrow({
      where: { sessionId },
    });
    if (!session.wsUrl) throw new Error('Browser Use CDP URL unavailable for screenshot');
    const { chromium } = await import('playwright');
    const browser = await chromium.connectOverCDP(session.wsUrl);
    try {
      const context = browser.contexts()[0];
      const page = context?.pages()[0];
      if (!page) throw new Error('Browser Use session has no page for screenshot');
      return { provider, image: await page.screenshot() };
    } finally {
      await browser.close().catch(() => {});
    }
  }

  const apiKey = process.env.STEEL_API_KEY?.trim();
  if (!apiKey) throw new Error('STEEL_API_KEY is required to capture Steel screenshots');
  return fetchProviderApi(
    steelApiUrl(`v1/sessions/${encodeURIComponent(sessionId)}/computer`),
    {
      method: 'POST',
      headers: { 'steel-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'take_screenshot' }),
    },
    async (response) => {
      if (!response.ok) throw new Error(`Steel screenshot failed: HTTP ${response.status}`);
      const result = (await response.json()) as { base64_image?: string };
      if (!result.base64_image)
        throw new Error('Steel screenshot response did not contain an image');
      return { provider, image: Buffer.from(result.base64_image, 'base64') };
    }
  );
}

export async function pressSessionKeys(
  sessionId: string,
  keys: string[]
): Promise<{
  provider: BrowserProviderName;
  supported: boolean;
  pressed: boolean;
}> {
  return pressSessionKeysUsingDependencies(sessionId, keys, {
    providerForSession,
    pressKernelKeys,
    pressBrowserUseKeys,
  });
}

export async function pressSessionKeysUsingDependencies(
  sessionId: string,
  keys: string[],
  dependencies: {
    providerForSession: (sessionId: string) => Promise<BrowserProviderName>;
    pressKernelKeys: (sessionId: string, keys: string[]) => Promise<void>;
    pressBrowserUseKeys: (sessionId: string, keys: string[]) => Promise<void>;
  }
): Promise<{
  provider: BrowserProviderName;
  supported: boolean;
  pressed: boolean;
}> {
  const provider = await dependencies.providerForSession(sessionId);
  if (provider === 'kernel') await dependencies.pressKernelKeys(sessionId, keys);
  else if (provider === 'browser-use') await dependencies.pressBrowserUseKeys(sessionId, keys);
  else return { provider, supported: false, pressed: false };
  return { provider, supported: true, pressed: true };
}

export async function closeAllActiveSessions(): Promise<number> {
  const sessions = await prisma.browserSession.findMany({
    where: { status: 'ACTIVE' },
    select: { sessionId: true },
  });
  await Promise.allSettled(
    sessions.flatMap((session) =>
      session.sessionId === null ? [] : [closeSession(session.sessionId)]
    )
  );
  return sessions.length;
}
