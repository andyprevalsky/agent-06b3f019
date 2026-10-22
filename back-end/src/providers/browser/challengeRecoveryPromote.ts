/** Config search + promote for browser challenge recovery (split for max-lines). */
import type { Prisma } from '@prisma/client';
import { prisma, runTransactionWithRetry } from '../database';
import { DEFAULT_GEOLOCATION, type ProxyGeoLocation } from '../geoip';
import { createLogger } from '../logger';
import { browserUseEnabled } from './config';
import type {
  ChallengeClassifierBilling,
  ChallengeClassifierLlmUsage,
} from './challengeLlmClassifier';
import {
  applyConfigBlacklist,
  runLaneConfigSearch,
  withProviderProbeLimits,
  type ConfigSearchDependencies,
} from './challengeRecoveryLaneSearch';
import { buildPreferredBrowserConfig, closeValidationBrowser } from './challengeRecoverySupport';
import {
  bestSpecificity,
  availableBrowserRecoveryCandidates,
  shouldPreferSteelForChallengeTarget,
  lockCandidatesToProvider,
  tilionRecoveryAvailable,
  transportFailureOrder,
} from './challengeRecoveryCandidates';
import type { FingerprintInjectionData } from './fingerprintInjection';
import { announceBrowserSessionBinding } from './sessionBindingAnnounce';
import {
  browserConfigSearchRuntimeDependencies,
  ChallengeConfigSearchExhaustedError,
  createTilionRecoveryCandidate,
  releaseRecoveryProviderSession,
  recoveryConfigKeyForSession,
  sameSiteNavigationUrl,
  type BrowserConfigSearchRuntimeDependencies,
  type RecoveryStorageLane,
} from './challengeRecovery';

const log = createLogger('BrowserChallengeRecovery');

export async function searchAndPromoteBrowserConfig(
  input: {
    taskId: string;
    userId?: string;
    targetUrl: string;
    storageState: Record<string, unknown>;
    /** Parallel cookie-signature lanes; defaults to a single lane from storageState. */
    storageLanes?: RecoveryStorageLane[];
    userAgent?: string;
    /** Failure-driven: blocked third-party URL that triggered this recovery. */
    blockedResourceUrl?: string;
    /** Agent recover_from_challenge reason for the LLM gate. */
    recoveryReason?: string | null;
    /** @deprecated Ignored — single LLM gate only. */
    requirePaymentCdn?: boolean;
    preserveAuth?: boolean;
    /** Cross-recovery dead configs; expired automatically when all are blocked. */
    blockedConfigKeys?: string[];
    /** Optional override; defaults to the task owner's stored fingerprint. */
    fingerprintInjection?: FingerprintInjectionData | null;
  },
  dependencies: BrowserConfigSearchRuntimeDependencies = browserConfigSearchRuntimeDependencies
) {
  const current = await prisma.browserSession.findFirst({
    where: {
      id: input.taskId,
      ...(input.userId === undefined ? {} : { context: { userId: input.userId } }),
    },
    include: { context: true },
  });
  if (current === null) throw new Error(`Browser task not found: ${input.taskId}`);
  const billing: ChallengeClassifierBilling = {
    agentId: current.agentId,
    userId: input.userId ?? current.context.userId,
  };
  const agent = await prisma.agent.findUnique({
    where: { id: current.agentId },
    select: { proxyCountry: true, proxyState: true, proxyCity: true },
  });
  const proxyLocation: ProxyGeoLocation = agent?.proxyCountry
    ? {
        country: agent.proxyCountry,
        ...(agent.proxyState ? { state: agent.proxyState } : {}),
        ...(agent.proxyCity ? { city: agent.proxyCity } : {}),
      }
    : DEFAULT_GEOLOCATION;
  const sessionAvoidConfigKey = recoveryConfigKeyForSession(current.provider, current.proxyTier);

  const fingerprintInjection =
    input.fingerprintInjection !== undefined
      ? input.fingerprintInjection
      : billing.userId
        ? await import('../steel/files').then((mod) =>
            mod.getFingerprintInjectionData(billing.userId!)
          )
        : null;
  // Payment-CDN hard filter removed. blockedResourceUrl is evidence for the LLM gate.
  void input.requirePaymentCdn;
  const preferSteel = shouldPreferSteelForChallengeTarget(input.targetUrl, {
    requirePaymentCdn: false,
  });
  const candidates = lockCandidatesToProvider(
    availableBrowserRecoveryCandidates(proxyLocation, { preferSteel }),
    current.provider,
    { taskId: input.taskId, phase: 'config_search' }
  );
  const transportFailure =
    /^(?:critical third-party resource blocked|first-party request blocked by proxy tunnel)$/i.test(
      (input.recoveryReason ?? '').trim()
    ) || /\bERR_(?:TUNNEL|PROXY)_CONNECTION_(?:FAILED|REFUSED)\b/i.test(input.recoveryReason ?? '');
  const configs =
    transportFailure &&
    (current.provider === 'kernel' || current.provider === 'steel' || current.provider === 'tilion')
      ? transportFailureOrder(candidates, current.provider, sessionAvoidConfigKey)
      : candidates;
  const blacklist = applyConfigBlacklist(configs, input.blockedConfigKeys);
  const searchableConfigs = blacklist.configs;
  if (blacklist.blacklistExpired) {
    log.info('Challenge recovery config blacklist expired; retrying full catalog', {
      taskId: input.taskId,
      blockedConfigKeys: input.blockedConfigKeys ?? [],
      agentId: billing.agentId,
    });
  }
  const lanes: RecoveryStorageLane[] =
    input.storageLanes && input.storageLanes.length > 0
      ? input.storageLanes
      : [{ key: 'default', storageState: input.storageState }];

  if (sessionAvoidConfigKey) {
    log.info('Challenge recovery will deprioritize current failing exit', {
      taskId: input.taskId,
      avoidConfigKey: sessionAvoidConfigKey,
      provider: current.provider,
      proxyTier: current.proxyTier,
    });
  }
  log.info('Challenge recovery lane search', {
    taskId: input.taskId,
    laneKeys: lanes.map((lane) => lane.key),
    configKeys: searchableConfigs.map((config) => config.key),
    blockedConfigKeys: input.blockedConfigKeys ?? [],
    blacklistExpired: blacklist.blacklistExpired,
    avoidConfigKey: sessionAvoidConfigKey ?? null,
    preserveAuth: input.preserveAuth ?? null,
    blockedResourceUrl: input.blockedResourceUrl ?? null,
    agentId: billing.agentId,
  });

  const failedConfigKeys = new Set<string>();

  const searchDependencies: ConfigSearchDependencies = {
    create: async (config, signal) => {
      if (signal.aborted) {
        throw new Error('lane_aborted');
      }
      if (config.provider === 'kernel') {
        const session = config.omitManagedProxy
          ? await dependencies.createKernel(current.agentId, proxyLocation, {
              omitManagedProxy: true,
            })
          : await dependencies.createKernel(current.agentId, proxyLocation, {
              type: config.kernelProxyType ?? 'residential',
              specificity: config.kernelSpecificity ?? bestSpecificity(proxyLocation),
            });
        if (signal.aborted) {
          await closeValidationBrowser(session);
          await dependencies.releaseKernel(session.sessionId).catch(() => {});
          throw new Error('lane_aborted');
        }
        return { provider: 'kernel', ...session };
      }
      if (config.provider === 'browser-use') {
        const session = await dependencies.createBrowserUse(proxyLocation);
        if (signal.aborted) {
          await closeValidationBrowser(session);
          await dependencies.releaseBrowserUse(session.sessionId).catch(() => {});
          throw new Error('lane_aborted');
        }
        return { provider: 'browser-use', ...session };
      }
      if (config.provider === 'tilion') {
        const session = await createTilionRecoveryCandidate(
          dependencies,
          proxyLocation,
          config.tilionProxyType ?? 'residential'
        );
        if (signal.aborted) {
          await closeValidationBrowser(session);
          await dependencies.releaseTilion(session.sessionId).catch(() => {});
          throw new Error('lane_aborted');
        }
        return session;
      }
      const session = await dependencies.createSteel({
        proxyLocation,
        proxyMode: config.steelProxyMode ?? 'managed',
        userAgent: input.userAgent,
      });
      if (signal.aborted) {
        await closeValidationBrowser(session);
        await dependencies.releaseSteel(session.sessionId).catch(() => {});
        throw new Error('lane_aborted');
      }
      return { provider: 'steel', ...session };
    },
    probe: async (config, session, lane, signal) => {
      if (signal.aborted) {
        throw new Error('lane_aborted');
      }
      const probe = await dependencies.probe(
        session,
        input.targetUrl,
        lane.storageState,
        {
          configKey: config.key,
          provider: config.provider,
          proxyMode: config.proxyMode,
          laneKey: lane.key,
          blockedResourceUrl: input.blockedResourceUrl,
          recoveryReason: input.recoveryReason,
          fingerprintInjection,
        },
        billing,
        signal
      );
      if (!(probe.stablePasses === probe.attempts && probe.attempts > 0)) {
        failedConfigKeys.add(config.key);
      }
      return probe;
    },
    promote: async ({ config, session }) => {
      if (config.provider === 'browser-use' && !browserUseEnabled()) {
        throw new Error('Browser Use is disabled by BROWSER_AGENT_BROWSER_USE_ENABLED');
      }
      if (config.provider === 'tilion' && !tilionRecoveryAvailable()) {
        throw new Error('Tilion is disabled by BROWSER_AGENT_TILION_ENABLED or has no API key');
      }
      // The worker reattaches with the returned URL; hand it a freshly minted one.
      if (config.provider === 'tilion' && dependencies.refreshTilionConnectUrl) {
        session.wsUrl = await dependencies.refreshTilionConnectUrl(session.sessionId);
      }
      const updated = await runTransactionWithRetry(async (tx) => {
        const replaced = await tx.browserSession.updateMany({
          where: { id: current.id, sessionId: current.sessionId },
          data: {
            sessionId: session.sessionId,
            debugUrl: session.debugUrl,
            wsUrl: session.wsUrl,
            currentUrl: input.targetUrl,
            status: 'ACTIVE',
            closedAt: null,
            provider: config.provider,
            kernelProxySource: config.provider === 'kernel' ? session.proxySource : null,
            providerProfileId: session.profileId,
            providerProfileSource: session.profileSource,
            providerProfilePersist: false,
            proxyTier: config.proxyMode,
          },
        });
        if (replaced.count !== 1) return false;
        await tx.browserContext.update({
          where: { id: current.contextId },
          data: {
            preferredBrowserConfig: buildPreferredBrowserConfig(
              config,
              proxyLocation
            ) as unknown as Prisma.InputJsonValue,
          },
        });
        return true;
      });
      if (!updated) throw new Error(`Browser task ${input.taskId} changed during config search`);
      // Tilion accepts one CDP client per session: the probe's client must be
      // gone before the agent reattaches to the promoted winner.
      if (session.provider === 'tilion') {
        const closeStarted = Date.now();
        await closeValidationBrowser(session);
        // Evidence for T74 (worker reattach refused 4409 after promotion): the
        // promoted Tilion session must have no backend CDP client left.
        const stillConnected = session.validationBrowser?.isConnected?.() ?? null;
        (stillConnected ? log.error : log.info).call(
          log,
          'Closed the promoted Tilion candidate CDP client before handing the session to the worker',
          {
            taskId: input.taskId,
            sessionId: session.sessionId,
            closeMs: Date.now() - closeStarted,
            stillConnected,
          }
        );
      }
      await (dependencies.announceBinding ?? announceBrowserSessionBinding)({ id: current.id });
      await releaseRecoveryProviderSession(dependencies, current.provider, current.sessionId).catch(
        () => {}
      );
    },
    release: async (_config, session) => {
      await closeValidationBrowser(session).catch(() => {});
      await releaseRecoveryProviderSession(dependencies, session.provider, session.sessionId);
    },
  };

  let winner: Awaited<ReturnType<typeof runLaneConfigSearch>>;
  try {
    winner = await runLaneConfigSearch(
      searchableConfigs,
      lanes,
      withProviderProbeLimits(searchDependencies),
      {
        avoidConfigKey: sessionAvoidConfigKey,
        blockedConfigKeys: blacklist.blacklistExpired ? [] : input.blockedConfigKeys,
        // Two transport-dead provider candidates get 90s each. The full search
        // stops at 210s, leaving 90s under the worker's 300s HTTP read deadline
        // for promotion, old-session release, and the response.
        ...(transportFailure ? { candidateDeadlineMs: 90_000, searchDeadlineMs: 210_000 } : {}),
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ChallengeConfigSearchExhaustedError(message, [...failedConfigKeys]);
  }
  const classifierLlmUsage: ChallengeClassifierLlmUsage[] = [
    ...(winner.probe.classifierLlmUsage ?? []),
  ];

  const resumeUrl =
    sameSiteNavigationUrl(input.targetUrl, winner.probe.settledUrl) ?? input.targetUrl;
  return {
    task_id: current.id,
    session_id: winner.session.sessionId,
    debug_url: winner.session.debugUrl,
    ws_url: winner.session.wsUrl,
    saved_url: resumeUrl,
    provider: winner.config.provider,
    proxy_tier: winner.config.proxyMode,
    config_key: winner.config.key,
    storage_state_preloaded: true,
    blacklist_expired: blacklist.blacklistExpired,
    failed_config_keys: [...failedConfigKeys],
    recovery_action:
      winner.config.provider === current.provider ? 'config_selected' : 'provider_switched',
    recovery_message: `Selected stable ${winner.config.key} browser configuration after ${winner.probe.attempts} clean probes.`,
    classifier_llm_usage: classifierLlmUsage,
    browser_session_metadata: {
      provider: winner.config.provider,
      proxy_source: winner.session.proxySource,
      proxy_location: winner.session.proxyLocation,
      proxy_tier: winner.config.proxyMode,
      config_key: winner.config.key,
      profile_id: null,
      profile_source: winner.session.profileSource,
    },
  };
}
