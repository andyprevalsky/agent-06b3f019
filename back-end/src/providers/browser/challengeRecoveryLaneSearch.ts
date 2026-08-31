import { createLogger } from '../logger';
import type { BrowserRecoveryConfig } from './challengeRecoveryCandidates';
import type {
  CandidateProbeResult,
  RecoveryCandidateSession,
  RecoveryStorageLane,
  SuccessfulRecoveryCandidate,
} from './challengeRecovery';

const log = createLogger('BrowserChallengeRecovery');

export interface ConfigSearchDependencies {
  create: (config: BrowserRecoveryConfig, signal: AbortSignal) => Promise<RecoveryCandidateSession>;
  probe: (
    config: BrowserRecoveryConfig,
    session: RecoveryCandidateSession,
    lane: RecoveryStorageLane,
    signal: AbortSignal
  ) => Promise<CandidateProbeResult>;
  promote: (winner: SuccessfulRecoveryCandidate) => Promise<void>;
  release: (config: BrowserRecoveryConfig, session: RecoveryCandidateSession) => Promise<void>;
}

export interface LaneConfigSearchOptions {
  /** Deprioritize this candidate key (tried last inside each lane). */
  avoidConfigKey?: string;
}

/** Order configs so the currently-failing exit is tried last within a lane. */
export function orderConfigsForLane(
  configs: BrowserRecoveryConfig[],
  avoidConfigKey?: string
): BrowserRecoveryConfig[] {
  if (!avoidConfigKey) return [...configs];
  const preferred = configs.filter((config) => config.key !== avoidConfigKey);
  const avoided = configs.filter((config) => config.key === avoidConfigKey);
  return [...preferred, ...avoided];
}

/**
 * Cookie-lane tournament:
 * - lanes run in parallel (each lane = distinct cookie signature)
 * - inside a lane, browser configs are tried one at a time
 * - first fully-stable probe (stablePasses === attempts) wins; siblings cancel
 * - partial clears are never promoted
 * - returns as soon as promote succeeds (must not await sibling lane probes —
 *   holding the recover-challenge HTTP open after releasing the old live
 *   session leaves the agent without a CDP URL while siblings still probe)
 */
export async function runLaneConfigSearch(
  configs: BrowserRecoveryConfig[],
  lanes: RecoveryStorageLane[],
  dependencies: ConfigSearchDependencies,
  options: LaneConfigSearchOptions = {}
): Promise<SuccessfulRecoveryCandidate> {
  if (lanes.length === 0) {
    throw new Error('Challenge recovery requires at least one cookie storage lane');
  }
  const avoidConfigKey = options.avoidConfigKey;
  const orderedConfigs = orderConfigsForLane(configs, avoidConfigKey);
  const abort = new AbortController();
  const claimLock = { claimed: false };
  /** Sessions still owned by in-flight sibling lanes — released on winner claim. */
  const activeSessions = new Set<{
    config: BrowserRecoveryConfig;
    session: RecoveryCandidateSession;
  }>();

  const releaseActiveSessions = async () => {
    const pending = [...activeSessions];
    activeSessions.clear();
    await Promise.all(
      pending.map(({ config, session }) => dependencies.release(config, session).catch(() => {}))
    );
  };

  abort.signal.addEventListener(
    'abort',
    () => {
      void releaseActiveSessions();
    },
    { once: true }
  );

  const throwIfAborted = () => {
    if (abort.signal.aborted || claimLock.claimed) {
      throw new Error('lane_aborted');
    }
  };

  const runWithAbort = async <T>(work: Promise<T>): Promise<T> => {
    throwIfAborted();
    return await new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new Error('lane_aborted'));
      abort.signal.addEventListener('abort', onAbort, { once: true });
      work.then(
        (value) => {
          abort.signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error) => {
          abort.signal.removeEventListener('abort', onAbort);
          reject(error);
        }
      );
    });
  };

  const runLane = async (lane: RecoveryStorageLane): Promise<SuccessfulRecoveryCandidate> => {
    for (const config of orderedConfigs) {
      throwIfAborted();
      let session: RecoveryCandidateSession;
      // Keep the create promise so a result that lands after abort can still be released.
      const createPromise = dependencies.create(config, abort.signal);
      try {
        session = await runWithAbort(createPromise);
      } catch (error) {
        void createPromise
          .then((lateSession) => dependencies.release(config, lateSession))
          .catch(() => {});
        if (error instanceof Error && error.message === 'lane_aborted') throw error;
        log.warn('Challenge recovery lane candidate create failed', {
          laneKey: lane.key,
          configKey: config.key,
          provider: config.provider,
          proxyMode: config.proxyMode,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const tracked = { config, session };
      activeSessions.add(tracked);
      if (abort.signal.aborted || claimLock.claimed) {
        activeSessions.delete(tracked);
        await dependencies.release(config, session).catch(() => {});
        throw new Error('lane_aborted');
      }
      try {
        const probe = await runWithAbort(dependencies.probe(config, session, lane, abort.signal));
        log.info('Challenge recovery lane candidate probed', {
          laneKey: lane.key,
          configKey: config.key,
          provider: config.provider,
          proxyMode: config.proxyMode,
          stablePasses: probe.stablePasses,
          attempts: probe.attempts,
          latencyMs: probe.latencyMs,
        });
        if (probe.stablePasses === probe.attempts && probe.attempts > 0) {
          activeSessions.delete(tracked);
          return { config, session, probe };
        }
        activeSessions.delete(tracked);
        await dependencies.release(config, session).catch(() => {});
      } catch (error) {
        // abort listener may already have cleared+released this session when a
        // sibling won; only release locally when we still own the track entry.
        const ownsSession = activeSessions.delete(tracked);
        log.warn('Challenge recovery lane candidate probe failed', {
          laneKey: lane.key,
          configKey: config.key,
          provider: config.provider,
          proxyMode: config.proxyMode,
          error: error instanceof Error ? error.message : String(error),
        });
        if (ownsSession) {
          await dependencies.release(config, session).catch(() => {});
        }
        if (abort.signal.aborted || claimLock.claimed) {
          throw new Error('lane_aborted');
        }
      }
    }
    throw new Error(`No stable browser configuration in lane ${lane.key}`);
  };

  return await new Promise<SuccessfulRecoveryCandidate>((resolve, reject) => {
    let settled = false;
    const laneErrors: string[] = [];
    let pendingLanes = lanes.length;

    const finishFailure = () => {
      if (settled || claimLock.claimed) return;
      settled = true;
      log.error('Challenge recovery found no stable browser configuration', {
        candidateCount: configs.length,
        laneCount: lanes.length,
        laneKeys: lanes.map((lane) => lane.key),
        configKeys: configs.map((config) => config.key),
        errors: laneErrors.slice(0, 8),
      });
      reject(new Error('No stable browser configuration cleared the challenge'));
    };

    const onLaneSettled = () => {
      pendingLanes -= 1;
      if (pendingLanes <= 0) finishFailure();
    };

    for (const lane of lanes) {
      void (async () => {
        try {
          const candidate = await runLane(lane);
          if (claimLock.claimed || settled) {
            await dependencies.release(candidate.config, candidate.session).catch(() => {});
            return;
          }
          claimLock.claimed = true;
          abort.abort();
          log.info('Challenge recovery promoting lane winner', {
            laneKey: lane.key,
            configKey: candidate.config.key,
            provider: candidate.config.provider,
            proxyMode: candidate.config.proxyMode,
            stablePasses: candidate.probe.stablePasses,
            attempts: candidate.probe.attempts,
            avoidConfigKey: avoidConfigKey ?? null,
            latencyMs: candidate.probe.latencyMs,
          });
          try {
            await dependencies.promote(candidate);
          } catch (error) {
            await dependencies.release(candidate.config, candidate.session).catch(() => {});
            claimLock.claimed = false;
            throw error;
          }
          if (!settled) {
            settled = true;
            resolve(candidate);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message !== 'lane_aborted') {
            laneErrors.push(message);
          }
        } finally {
          onLaneSettled();
        }
      })();
    }
  });
}

/**
 * @deprecated Prefer ``runLaneConfigSearch``. Single-lane wrapper for older
 * call sites/tests; configs are sequential (no all-config parallel storm).
 */
export async function runParallelBrowserConfigSearch(
  configs: BrowserRecoveryConfig[],
  dependencies: {
    create: ConfigSearchDependencies['create'];
    probe: (
      config: BrowserRecoveryConfig,
      session?: RecoveryCandidateSession,
      signal?: AbortSignal
    ) => Promise<CandidateProbeResult>;
    promote: ConfigSearchDependencies['promote'];
    release: ConfigSearchDependencies['release'];
  },
  options: LaneConfigSearchOptions & { requirePaymentCdn?: boolean } = {}
): Promise<SuccessfulRecoveryCandidate> {
  // requirePaymentCdn intentionally ignored — single LLM gate only.
  void options.requirePaymentCdn;
  return runLaneConfigSearch(
    configs,
    [{ key: 'default', storageState: {} }],
    {
      create: (config, signal) => dependencies.create(config, signal),
      probe: async (config, session, _lane, signal) => dependencies.probe(config, session, signal),
      promote: dependencies.promote,
      release: dependencies.release,
    },
    { avoidConfigKey: options.avoidConfigKey }
  );
}
