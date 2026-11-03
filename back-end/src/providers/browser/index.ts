import { withLogicalBrowserPause } from './logicalPause';
import { prisma } from '../database';
import { DEFAULT_GEOLOCATION, type ProxyGeoLocation } from '../geoip';
import { createLogger } from '../logger';
import {
  closeSession as closeSteelSession,
  createSessionWithContext as createSteelSessionWithContext,
  resumeSession as resumeSteelSession,
} from '../steel/session';
import { getSteelCaptchaTelemetry, getSteelSessionHealth } from '../steel/sessionInspect';
import { rotateSession as rotateSteelSession } from '../steel/sessionResume';
import { getFingerprintInjectionData } from '../steel/files';
import { injectUserData } from '../steel/injection';
import { compatiblePreferredBrowserConfig } from './challengeRecovery';
import {
  browserUseEnabled,
  DEFAULT_BROWSER_PROVIDER,
  selectedBrowserProvider,
  tilionEnabled,
} from './config';
import { getOrCreateBrowserContext } from './context';
import {
  closeBrowserUseSession,
  createBrowserUseSessionWithContext,
  getBrowserUseSessionHealth,
  resumeBrowserUseSession,
  rotateBrowserUseSession,
} from './browserUse';
import {
  closeKernelSession,
  createKernelSessionWithContext,
  getKernelSessionHealth,
  getKernelCaptchaTelemetry,
  resumeKernelSession,
  rotateKernelSession,
} from './kernel';
import type { KernelProxyType } from './kernelProxy';
import type { RotationRecoveryAction, RotationStep } from './rotation';
import { persistSignedInBrowserState } from './sessionAuthPersist';
import { mergeSessionWorldState, type WorldStateMergeReceipt } from './worldState';
import {
  closeTilionSession,
  createTilionSessionWithContext,
  getTilionCaptchaTelemetry,
  getTilionSessionHealth,
  resumeTilionSession,
  rotateTilionSession,
  type TilionCarriedState,
} from './tilion';
import { releaseSupersededBrowser } from './sessionCleanup';
import { providerForSession, providerForTask } from './sessionProvider';
import {
  type BrowserProviderName,
  type BrowserProviderResumeSession,
  type BrowserProviderSelection,
  type BrowserProviderSession,
  type BrowserSessionHealth,
} from './types';

export {
  BrowserProviderRateLimitError,
  type BrowserFileInfo,
  type BrowserProviderName,
  type BrowserSessionHealth,
  type BrowserViewport,
  type BrowserViewportResizeResult,
} from './types';
export { selectedBrowserProvider, tilionEnabled, TilionApiKeyMissingError } from './config';

/*
 * Tilion single-CDP-client ordering (lane E live probe, 2026-10-21). A Tilion
 * session accepts ONE CDP socket: a second is accepted then closed with 4409
 * while the first is unaffected, and the same token reattaches after the first
 * disconnects. While a CDP client is attached, REST drive calls do not wait:
 * act answers 409 `session_driven_by_client` and files/fetch 409/502; /status
 * keeps working, and since 2026-11 a read-only screenshot is served beside the
 * client (200, `beside_client: true`). Backend paths therefore:
 *
 *   initSession:   create (validation socket) → injectUserData (reuses it) → close it → worker attaches
 *   prepare-auth / inject-local-storage (JIT):  worker detaches → backend CDP → worker reattaches
 *   closeSession:  worker detaches → persistSignedInBrowserState harvest → provider release
 *   screenshot / press-key / file read+list+upload: REST, valid only while no client is
 *     attached; mid-run they raise TilionSessionBusyError (HTTP 409
 *     `session_driven_by_client`) and the worker uses its own CDP connection instead.
 *   health / captcha telemetry / live view: REST status and token mints, safe while attached.
 *
 * A harvest that still collides is logged and the release proceeds, so a busy
 * socket can cost a sign-in harvest but never leak a paid session.
 */
export { injectUserData, getFingerprintInjectionData };
export {
  BrowserOperationWorkerOwnedError,
  captureScreenshot,
  listFiles,
  pressSessionKeys,
  pressSessionKeysUsingDependencies,
  readSessionFile,
  resizeSessionViewport,
  uploadSessionFile,
} from './sessionIo';

export const getOrCreateContext = getOrCreateBrowserContext;
const log = createLogger('BrowserProvider');

export interface BrowserSessionCreationDependencies {
  readPreferredConfig: (contextId: string) => Promise<unknown>;
  defaultProvider: () => BrowserProviderName;
  createKernel: typeof createKernelSessionWithContext;
  createSteel: typeof createSteelSessionWithContext;
  createBrowserUse: typeof createBrowserUseSessionWithContext;
  createTilion: typeof createTilionSessionWithContext;
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
  createTilion: createTilionSessionWithContext,
};

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
    if (provider === 'tilion') {
      if (!tilionEnabled()) {
        throw new Error('Tilion is disabled by BROWSER_AGENT_TILION_ENABLED');
      }
      return dependencies.createTilion(contextId, agentId, proxyLocation, startUrl, {
        ...(options?.keepValidationConnection !== undefined
          ? { keepValidationConnection: options.keepValidationConnection }
          : {}),
        ...(options?.taskId !== undefined ? { taskId: options.taskId } : {}),
        // A recovery-promoted Tilion exit type (e.g. mobile) must survive into the next session.
        ...(usePreference?.tilionProxyType ? { proxyType: usePreference.tilionProxyType } : {}),
      });
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

  let fallback: BrowserProviderSelection | undefined;
  if (preferred !== null && preferred.provider === 'tilion' && !tilionEnabled()) {
    fallback = { requestedProvider: 'tilion', fallbackReason: 'preferred_provider_kill_switch' };
  }
  if (
    preferred !== null &&
    (preferred.provider !== 'browser-use' || browserUseEnabled()) &&
    (preferred.provider !== 'tilion' || tilionEnabled())
  ) {
    try {
      return await createForProvider(preferred.provider, preferred);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fallback = {
        requestedProvider: preferred.provider,
        fallbackReason: `preferred_config_create_failed: ${message.slice(0, 200)}`,
      };
      log.warn('Preferred browser config unavailable; falling back to deployment default', {
        contextId,
        preferredProvider: preferred.provider,
        preferredProxyMode: preferred.proxyMode,
        error: message,
      });
    }
  }
  // A failure of the default provider propagates (typed by the adapter); never swallowed.
  const defaultProvider = dependencies.defaultProvider();
  if (fallback === undefined && defaultProvider === 'kernel' && tilionKillSwitchRedirect()) {
    fallback = { requestedProvider: 'tilion', fallbackReason: 'tilion_kill_switch' };
  }
  const session = await createForProvider(defaultProvider, null);
  if (fallback === undefined || fallback.requestedProvider === session.provider) return session;
  log.warn('Browser session created on a fallback provider', {
    contextId,
    requestedProvider: fallback.requestedProvider,
    actualProvider: session.provider,
    fallbackReason: fallback.fallbackReason,
  });
  return { ...session, providerSelection: fallback };
}

/** BROWSER_PROVIDER asks for Tilion (explicitly or by default) but its kill switch is off. */
function tilionKillSwitchRedirect(): boolean {
  const configured = (process.env.BROWSER_PROVIDER ?? DEFAULT_BROWSER_PROVIDER)
    .trim()
    .toLowerCase();
  return configured === 'tilion' && !tilionEnabled();
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
  return withLogicalBrowserPause(logical, sessionId, pause, async (providerPause) => {
    // A logical pause keeps its state private in the checkpoint. Retiring a
    // logical browser ends that state, so its verified logins are published like
    // any other browser's: the harvest takes only realms with sign-in evidence on
    // this exact session.
    if (!(pause && logical?.logicalOwnerKey))
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
    if (provider === 'kernel') await closeKernelSession(sessionId, providerPause, currentUrl);
    else if (provider === 'browser-use')
      await closeBrowserUseSession(sessionId, providerPause, currentUrl);
    else if (provider === 'tilion') await closeTilionSession(sessionId, providerPause, currentUrl);
    else await closeSteelSession(sessionId, providerPause, currentUrl);
    return { worldState: merged };
  });
}

export async function resumeSession(
  taskId: string,
  options: {
    forceFreshProfile?: boolean;
    keepValidationConnection?: boolean;
    /** Worker-captured storage_state of a live Tilion session; ignored by other providers. */
    carriedState?: TilionCarriedState;
  } = {}
): Promise<BrowserProviderResumeSession> {
  const { carriedState, ...providerOptions } = options;
  const provider = await providerForTask(taskId);
  if (provider === 'kernel') return resumeKernelSession(taskId, providerOptions);
  if (provider === 'tilion' && tilionEnabled()) {
    const { previousSessionId, previousProvider, ...session } = await resumeTilionSession(taskId, {
      ...providerOptions,
      ...(carriedState !== undefined ? { carriedState } : {}),
    });
    if (
      previousSessionId !== null &&
      previousSessionId !== '' &&
      previousSessionId !== session.sessionId
    ) {
      await releaseSupersededBrowser({
        taskId,
        previousProvider,
        previousSessionId,
        operation: 'resume',
      });
    }
    return session;
  }
  if (provider === 'browser-use' || provider === 'tilion') {
    // A disabled rollout provider resumes on Kernel and releases its old session.
    // A Tilion row's state (paused snapshot) is carried by resumeBrowserSession.
    if (provider === 'tilion' || !browserUseEnabled()) {
      const previous = await prisma.browserSession.findUniqueOrThrow({
        where: { id: taskId },
        select: { sessionId: true },
      });
      const replacement = await resumeKernelSession(taskId, providerOptions);
      await releaseSupersededBrowser({
        taskId,
        previousProvider: provider,
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

  const replacement = await resumeSteelSession(taskId, providerOptions);
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
  ipRotation?: {
    rotated: boolean;
    freshAllocation: boolean;
    region: string | null;
  };
  previousProvider: BrowserProviderName;
  recoveryAction: RotationRecoveryAction;
  proxyType: KernelProxyType;
}

/** Execute one server-selected rotate_ip recovery step. */
export async function rotateProxy(
  taskId: string,
  step: RotationStep,
  options: {
    keepValidationConnection?: boolean;
    /** Worker-captured storage_state of a live Tilion session; ignored by other providers. */
    carriedState?: TilionCarriedState;
  } = {}
): Promise<BrowserProxyRotationResult> {
  const { carriedState, ...providerOptions } = options;
  const currentProvider = await providerForTask(taskId);
  if (step.provider === 'kernel') {
    // Tilion → Kernel is a ladder step; recreateKernelSession accepts the
    // non-Kernel row but evicts only Kernel predecessors, so release Tilion here.
    if (currentProvider !== 'kernel' && currentProvider !== 'tilion') {
      throw new ProxyRotationUnsupportedError(currentProvider);
    }
    const previous =
      currentProvider === 'tilion'
        ? await prisma.browserSession.findUniqueOrThrow({
            where: { id: taskId },
            select: { sessionId: true },
          })
        : null;
    const session = await rotateKernelSession(taskId, step.proxyType, providerOptions);
    if (previous !== null) {
      await releaseSupersededBrowser({
        taskId,
        previousProvider: 'tilion',
        previousSessionId: previous.sessionId,
        operation: 'rotation',
      });
    }
    return {
      ...session,
      previousProvider: currentProvider,
      recoveryAction: step.recoveryAction,
      proxyType: step.proxyType,
    };
  }

  if (step.provider === 'tilion') {
    if (!tilionEnabled()) {
      throw new Error('Tilion is disabled by BROWSER_AGENT_TILION_ENABLED');
    }
    if (currentProvider !== 'tilion') throw new ProxyRotationUnsupportedError(currentProvider);
    const { previousSessionId, previousProvider, ...session } = await rotateTilionSession(
      taskId,
      step.proxyType,
      { ...providerOptions, ...(carriedState !== undefined ? { carriedState } : {}) }
    );
    // An in-place rotate-ip keeps the session id; releasing it would kill the live browser.
    if (
      previousSessionId !== null &&
      previousSessionId !== '' &&
      previousSessionId !== session.sessionId
    ) {
      await releaseSupersededBrowser({
        taskId,
        previousProvider,
        previousSessionId,
        operation: 'rotation',
      });
    }
    return {
      ...session,
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

  const replacement = await rotateSteelSession(taskId, providerOptions);
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
  if (provider === 'tilion') return getTilionSessionHealth(sessionId);

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
  if (session.provider === 'tilion') return getTilionCaptchaTelemetry(session.sessionId);
  return session.provider === 'kernel'
    ? getKernelCaptchaTelemetry(session.sessionId)
    : getSteelCaptchaTelemetry(session.sessionId);
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
