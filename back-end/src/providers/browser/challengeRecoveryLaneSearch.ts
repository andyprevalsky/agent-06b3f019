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
  /** Cancellation of this request, distinct from a winning lane stopping siblings. */
  signal?: AbortSignal;
  /** Deprioritize this candidate key (tried last inside each lane). */
  avoidConfigKey?: string;
  /**
   * Cross-recovery blacklist: hard-exclude these keys. When every catalog
   * entry is blacklisted, the set expires and the full catalog is retried.
   */
  blockedConfigKeys?: Iterable<string>;
  /** Bound one create + probe when a broken transport would otherwise stall failover. */
  candidateDeadlineMs?: number;
  /** End the whole candidate search before its HTTP caller's read deadline. */
  searchDeadlineMs?: number;
  /** Agent the search recovers for: its cleanup aborts the search (abortRecoverySearchesFor). */
  ownerKey?: string;
}

/**
 * Candidate sessions created by every in-flight recovery search, so a backend
 * shutdown can release them (T107: two tilion_direct probes outlived SIGTERM and
 * kept billing against the shared account cap). Release is idempotent: a session
 * is DELETEd only while this registry still owns it.
 */
const liveProbeSessions = new Map<RecoveryCandidateSession, () => Promise<void>>();
const inFlightProbeCreates = new Set<Promise<unknown>>();
const inFlightProbeReleases = new Set<Promise<void>>();
const liveSearchAborts = new Map<AbortController, string | undefined>();
/**
 * Set once backend shutdown begins. The HTTP listener stays open while the
 * cleanup awaits, so a search or create admitted after its snapshot would rent
 * a browser nothing releases before process.exit.
 */
let recoveryAdmissionsClosed = false;

function withProbeSessionRegistry(
  dependencies: ConfigSearchDependencies
): ConfigSearchDependencies {
  const releaseOwned = (config: BrowserRecoveryConfig, session: RecoveryCandidateSession) => {
    if (!liveProbeSessions.delete(session)) return Promise.resolve();
    const releasing = dependencies.release(config, session);
    inFlightProbeReleases.add(releasing);
    void releasing.catch(() => {}).finally(() => inFlightProbeReleases.delete(releasing));
    return releasing;
  };
  return {
    ...dependencies,
    create: async (config, signal) => {
      if (recoveryAdmissionsClosed) throw new Error('lane_aborted');
      const creating = dependencies.create(config, signal);
      inFlightProbeCreates.add(creating);
      try {
        const session = await creating;
        liveProbeSessions.set(session, () => releaseOwned(config, session));
        return session;
      } finally {
        inFlightProbeCreates.delete(creating);
      }
    },
    release: (config, session) => releaseOwned(config, session),
    promote: async (winner) => {
      // The promoted session becomes the task's own browser (reconciled with the agent).
      const release = liveProbeSessions.get(winner.session);
      liveProbeSessions.delete(winner.session);
      try {
        await dependencies.promote(winner);
      } catch (error) {
        if (release) liveProbeSessions.set(winner.session, release);
        throw error;
      }
    },
  };
}

/**
 * An agent stopped (cleanup/delete): abort its running recovery searches so they
 * create no further candidates and release the ones they hold (T107: a search
 * allocated a new Tilion probe 4 s after its agent's browsers were closed).
 */
export function abortRecoverySearchesFor(ownerKey: string): number {
  let aborted = 0;
  for (const [controller, owner] of liveSearchAborts) {
    if (owner !== ownerKey || controller.signal.aborted) continue;
    controller.abort();
    aborted += 1;
  }
  if (aborted > 0)
    log.info('Challenge recovery search aborted for stopped agent', { ownerKey, aborted });
  return aborted;
}

/** Recovery candidate sessions currently owned by a search (diagnostics/tests). */
export function liveRecoveryProbeSessionCount(): number {
  return liveProbeSessions.size;
}

/**
 * Backend shutdown: abort every live recovery search and release each candidate
 * session it still owns, including ones whose create lands meanwhile. New
 * searches and creates are refused from here on. Bounded best-effort: waiting
 * for creates and waiting for releases each get `timeoutMs`, so creates that use
 * up their budget cannot leave a started DELETE racing process.exit. Returns how
 * many sessions were released.
 */
export async function releaseAllRecoveryProbeSessions(timeoutMs = 8_000): Promise<number> {
  recoveryAdmissionsClosed = true;
  const budget = () => new Promise<null>((resolve) => setTimeout(resolve, timeoutMs, null).unref());
  const owned = liveProbeSessions.size + inFlightProbeCreates.size;
  for (const controller of [...liveSearchAborts.keys()]) controller.abort();
  await Promise.race([Promise.allSettled([...inFlightProbeCreates]), budget()]);
  for (const release of [...liveProbeSessions.values()]) void release();
  const releases = [...inFlightProbeReleases];
  const settled = await Promise.race([Promise.allSettled(releases), budget()]);
  const released = settled ? settled.filter((result) => result.status === 'fulfilled').length : 0;
  if (owned > 0 || releases.length > 0) {
    log.info('Challenge recovery probe sessions released on shutdown', {
      owned,
      released,
      timedOut: settled === null,
    });
  }
  return released;
}

/** Tests only: reopen admissions after a simulated shutdown in the same process. */
export function reopenRecoveryAdmissionsForTests(): void {
  recoveryAdmissionsClosed = false;
}

/**
 * Drop blacklisted configs. If the blacklist covers the whole catalog,
 * expire it and return the full list (caller may clear durable state).
 */
export function applyConfigBlacklist(
  configs: BrowserRecoveryConfig[],
  blockedConfigKeys?: Iterable<string>
): { configs: BrowserRecoveryConfig[]; blacklistExpired: boolean } {
  const blocked = new Set(
    [...(blockedConfigKeys ?? [])].map((key) => String(key || '').trim()).filter(Boolean)
  );
  if (blocked.size === 0) return { configs: [...configs], blacklistExpired: false };
  const remaining = configs.filter((config) => !blocked.has(config.key));
  if (remaining.length === 0) {
    return { configs: [...configs], blacklistExpired: true };
  }
  return { configs: remaining, blacklistExpired: false };
}

/** Order configs so the currently-failing exit is tried last within a lane. */
export function orderConfigsForLane(
  configs: BrowserRecoveryConfig[],
  avoidConfigKey?: string,
  blockedConfigKeys?: Iterable<string>
): BrowserRecoveryConfig[] {
  const { configs: pool } = applyConfigBlacklist(configs, blockedConfigKeys);
  if (!avoidConfigKey) return pool;
  const preferred = pool.filter((config) => config.key !== avoidConfigKey);
  const avoided = pool.filter((config) => config.key === avoidConfigKey);
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
  options.signal?.throwIfAborted();
  if (lanes.length === 0) {
    throw new Error('Challenge recovery requires at least one cookie storage lane');
  }
  if (recoveryAdmissionsClosed) {
    throw new Error('Challenge recovery unavailable: backend is shutting down');
  }
  dependencies = withProbeSessionRegistry(dependencies);
  const avoidConfigKey = options.avoidConfigKey;
  const orderedConfigs = orderConfigsForLane(configs, avoidConfigKey, options.blockedConfigKeys);
  const abort = new AbortController();
  liveSearchAborts.set(abort, options.ownerKey);
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

  const abortForCaller = () => abort.abort();
  options.signal?.addEventListener('abort', abortForCaller, { once: true });
  if (options.signal?.aborted) abortForCaller();

  const throwIfAborted = () => {
    if (abort.signal.aborted || claimLock.claimed) {
      throw new Error('lane_aborted');
    }
  };

  const runWithAbort = async <T>(
    work: Promise<T>,
    signal: AbortSignal = abort.signal
  ): Promise<T> => {
    throwIfAborted();
    const interruption = () =>
      new Error(
        abort.signal.aborted || claimLock.claimed ? 'lane_aborted' : 'candidate_deadline_exceeded'
      );
    if (signal.aborted) throw interruption();
    return await new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(interruption());
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      work.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        }
      );
    });
  };

  const runLane = async (lane: RecoveryStorageLane): Promise<SuccessfulRecoveryCandidate> => {
    for (const config of orderedConfigs) {
      throwIfAborted();
      const deadline = new AbortController();
      const deadlineTimer = options.candidateDeadlineMs
        ? setTimeout(() => deadline.abort(), options.candidateDeadlineMs)
        : undefined;
      const candidateSignal = deadlineTimer
        ? AbortSignal.any([abort.signal, deadline.signal])
        : abort.signal;
      try {
        let session: RecoveryCandidateSession;
        // Keep the create promise so a result that lands after abort can still be released.
        const createPromise = dependencies.create(config, candidateSignal);
        try {
          session = await runWithAbort(createPromise, candidateSignal);
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
        if (candidateSignal.aborted || claimLock.claimed) {
          activeSessions.delete(tracked);
          await dependencies.release(config, session).catch(() => {});
          if (abort.signal.aborted || claimLock.claimed) throw new Error('lane_aborted');
          continue;
        }
        try {
          const probe = await runWithAbort(
            dependencies.probe(config, session, lane, candidateSignal),
            candidateSignal
          );
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
            const ownsSession = activeSessions.delete(tracked);
            if (!ownsSession) {
              throw new Error('lane_aborted');
            }
            return { config, session, probe };
          }
          if (activeSessions.delete(tracked)) {
            await dependencies.release(config, session).catch(() => {});
          }
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
      } finally {
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      }
    }
    throw new Error(`No stable browser configuration in lane ${lane.key}`);
  };

  try {
    return await new Promise<SuccessfulRecoveryCandidate>((resolve, reject) => {
      let settled = false;
      let deadlineExpired = false;
      const laneErrors: string[] = [];
      let pendingLanes = lanes.length;
      const failDeadline = () => {
        if (settled) return;
        settled = true;
        abort.abort();
        log.error('Challenge recovery search deadline exceeded', {
          candidateCount: configs.length,
          laneCount: lanes.length,
          searchDeadlineMs: options.searchDeadlineMs,
        });
        reject(new Error('Challenge recovery search deadline exceeded'));
      };
      const searchDeadlineTimer = options.searchDeadlineMs
        ? setTimeout(() => {
            deadlineExpired = true;
            if (!claimLock.claimed) failDeadline();
          }, options.searchDeadlineMs)
        : undefined;

      const clearSearchDeadline = () => {
        if (searchDeadlineTimer !== undefined) clearTimeout(searchDeadlineTimer);
      };

      const finishFailure = () => {
        if (settled || claimLock.claimed) return;
        settled = true;
        clearSearchDeadline();
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
              if (deadlineExpired) failDeadline();
              throw error;
            }
            clearSearchDeadline();
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
  } finally {
    options.signal?.removeEventListener('abort', abortForCaller);
    liveSearchAborts.delete(abort);
  }
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

/** Default cap on live candidate sessions per recovery for a concurrency-capped provider. */
export const TILION_MAX_PARALLEL_RECOVERY_PROBES_DEFAULT = 2;

/**
 * Live candidate sessions one recovery may hold at once on a provider whose
 * account caps concurrent sessions (Tilion: 20 shared by every run), or null
 * when the provider is not capped. Parallel storage lanes each open their own
 * candidate, so without this one recovery opened 5 Tilion sessions (T85).
 * BROWSER_RECOVERY_TILION_MAX_PARALLEL_PROBES overrides the default of 2.
 */
export function maxParallelRecoveryProbes(provider: string): number | null {
  if (provider !== 'tilion') return null;
  const raw = Number(process.env.BROWSER_RECOVERY_TILION_MAX_PARALLEL_PROBES);
  return Number.isInteger(raw) && raw >= 1 ? raw : TILION_MAX_PARALLEL_RECOVERY_PROBES_DEFAULT;
}

class ProbeSlots {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly limit: number) {}

  async acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('lane_aborted');
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal.removeEventListener('abort', onAbort);
        this.active += 1;
        resolve();
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(grant);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error('lane_aborted'));
      };
      this.waiters.push(grant);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    this.waiters.shift()?.();
  }
}

/**
 * Bound live candidate sessions per capped provider for one recovery. A slot is
 * taken before create and freed when that candidate is released or promoted
 * (the promoted session becomes the task's own); uncapped providers pass through.
 */
export function withProviderProbeLimits(
  dependencies: ConfigSearchDependencies
): ConfigSearchDependencies {
  const slotsByProvider = new Map<string, ProbeSlots>();
  const holding = new WeakSet<RecoveryCandidateSession>();
  const slotsFor = (provider: string): ProbeSlots | null => {
    const limit = maxParallelRecoveryProbes(provider);
    if (limit === null) return null;
    let slots = slotsByProvider.get(provider);
    if (!slots) {
      slots = new ProbeSlots(limit);
      slotsByProvider.set(provider, slots);
    }
    return slots;
  };
  const free = (session: RecoveryCandidateSession) => {
    if (!holding.has(session)) return;
    holding.delete(session);
    slotsFor(session.provider)?.release();
  };
  return {
    ...dependencies,
    create: async (config, signal) => {
      const slots = slotsFor(config.provider);
      if (slots === null) return dependencies.create(config, signal);
      await slots.acquire(signal);
      try {
        const session = await dependencies.create(config, signal);
        holding.add(session);
        return session;
      } catch (error) {
        slots.release();
        throw error;
      }
    },
    release: async (config, session) => {
      try {
        await dependencies.release(config, session);
      } finally {
        free(session);
      }
    },
    promote: async (winner) => {
      await dependencies.promote(winner);
      free(winner.session);
    },
  };
}
