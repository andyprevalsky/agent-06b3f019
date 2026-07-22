import { prisma } from '../database';
import { DEFAULT_GEOLOCATION, type ProxyGeoLocation } from '../geoip';
import {
  closeSession as closeSteelSession,
  createSessionWithContext as createSteelSessionWithContext,
  getSteelSessionHealth,
  releaseSteelRemoteSession,
  resumeSession as resumeSteelSession,
  steelApiUrl,
} from '../steel/session';
import { rotateSession as rotateSteelSession } from '../steel/sessionResume';
import { getFingerprintInjectionData, listSessionFiles, uploadFileToSession } from '../steel/files';
import { injectUserData } from '../steel/injection';
import { createLogger } from '../logger';
import { selectedBrowserProvider } from './config';
import { getOrCreateBrowserContext } from './context';
import {
  captureKernelScreenshot,
  closeKernelSession,
  createKernelSessionWithContext,
  getKernelSessionHealth,
  listKernelSessionFiles,
  readKernelSessionFile,
  releaseKernelRemoteSession,
  resizeKernelViewport,
  resumeKernelSession,
  rotateKernelSession,
  uploadKernelSessionFile,
} from './kernel';
import type { KernelProxyType } from './kernelProxy';
import type { RotationRecoveryAction, RotationStep } from './rotation';
import type {
  BrowserFileInfo,
  BrowserProviderName,
  BrowserProviderResumeSession,
  BrowserProviderSession,
  BrowserSessionHealth,
  BrowserViewport,
  BrowserViewportResizeResult,
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
  return session.provider === 'kernel' ? 'kernel' : 'steel';
}

async function providerForTask(taskId: string): Promise<BrowserProviderName> {
  const session = await prisma.browserSession.findUnique({
    where: { id: taskId },
    select: { provider: true },
  });
  if (session === null) throw new Error(`Browser task not found: ${taskId}`);
  return session.provider === 'kernel' ? 'kernel' : 'steel';
}

export async function createSessionWithContext(
  contextId: string,
  agentId: string,
  proxyLocation: ProxyGeoLocation = DEFAULT_GEOLOCATION,
  startUrl?: string,
  options?: { keepValidationConnection?: boolean }
): Promise<BrowserProviderSession> {
  if (selectedBrowserProvider() === 'kernel') {
    return createKernelSessionWithContext(contextId, agentId, proxyLocation, startUrl, options);
  }

  const session = await createSteelSessionWithContext(
    contextId,
    agentId,
    proxyLocation,
    startUrl,
    options
  );
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
}

export async function closeSession(
  sessionId: string,
  pause = false,
  currentUrl?: string
): Promise<void> {
  const provider = await providerForSession(sessionId);
  if (provider === 'kernel') {
    await closeKernelSession(sessionId, pause, currentUrl);
    return;
  }
  await closeSteelSession(sessionId, pause, currentUrl);
}

export async function resumeSession(taskId: string): Promise<BrowserProviderResumeSession> {
  const provider = await providerForTask(taskId);
  if (provider === 'kernel') return resumeKernelSession(taskId);

  const session = await resumeSteelSession(taskId);
  return {
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
  step: RotationStep
): Promise<BrowserProxyRotationResult> {
  const currentProvider = await providerForTask(taskId);
  if (step.provider === 'kernel') {
    if (currentProvider !== 'kernel') throw new ProxyRotationUnsupportedError(currentProvider);
    return {
      ...(await rotateKernelSession(taskId, step.proxyType)),
      previousProvider: currentProvider,
      recoveryAction: step.recoveryAction,
      proxyType: step.proxyType,
    };
  }

  const replacement = await rotateSteelSession(taskId);
  const { previousSessionId, previousProvider, ...session } = replacement;
  const releasePrevious =
    previousProvider === 'kernel'
      ? releaseKernelRemoteSession(previousSessionId)
      : releaseSteelRemoteSession(previousSessionId);
  await releasePrevious.catch((error) => {
    log.warn('Failed to release superseded browser after Steel rotation', {
      taskId,
      previousProvider,
      previousSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  return {
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

  const health = await getSteelSessionHealth(sessionId);
  return { provider: 'steel', ...health };
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
  mimeType = 'application/octet-stream'
): Promise<{ path: string; size: number }> {
  const provider = await providerForSession(sessionId);
  return provider === 'kernel'
    ? uploadKernelSessionFile(sessionId, fileBuffer, filename)
    : uploadFileToSession(sessionId, fileBuffer, filename, mimeType);
}

export async function listFiles(sessionId: string): Promise<BrowserFileInfo[]> {
  const provider = await providerForSession(sessionId);
  return provider === 'kernel' ? listKernelSessionFiles(sessionId) : listSessionFiles(sessionId);
}

export async function readSessionFile(sessionId: string, filePath: string): Promise<Buffer> {
  const provider = await providerForSession(sessionId);
  if (provider === 'kernel') return readKernelSessionFile(sessionId, filePath);

  const apiKey = process.env.STEEL_API_KEY?.trim();
  if (!apiKey) throw new Error('STEEL_API_KEY is required to read Steel session files');
  const relativePath = filePath.replace(/^\/files\//, '').replace(/^\//, '');
  return fetchProviderApi(
    steelApiUrl(`v1/sessions/${encodeURIComponent(sessionId)}/files/${relativePath}`),
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

export async function closeAllActiveSessions(): Promise<number> {
  const sessions = await prisma.browserSession.findMany({
    where: { status: 'ACTIVE' },
    select: { sessionId: true },
  });
  await Promise.allSettled(sessions.map((session) => closeSession(session.sessionId)));
  return sessions.length;
}
