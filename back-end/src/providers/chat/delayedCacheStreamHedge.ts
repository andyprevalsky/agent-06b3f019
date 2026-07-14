/**
 * Delayed cache/live hedge state flow:
 *
 *                         cache hit ───────────────> CACHE (live never starts)
 *                        /
 *   lookup + 25ms grace ─┼─ miss/error ───────────> LIVE
 *                        \
 *                         timeout ─> start live ─┬─ cache hit before content -> CACHE + abort live
 *                                                └─ first live content/reasoning -> LIVE (winner locked)
 *
 * Chunks produced before the first meaningful live delta stay buffered. That
 * gives the cache one bounded chance to win without ever splicing two streams.
 */

export type CacheLookupResult<T> = { hit: true; value: T } | { hit: false };
export type HedgeWinner = 'cache' | 'live';

interface DelayedCacheStreamHedgeOptions<TCache, TChunk> {
  readCache: () => Promise<CacheLookupResult<TCache>>;
  createLive: (abortSignal: AbortSignal) => Promise<AsyncIterable<TChunk>>;
  createCached: (value: TCache) => AsyncIterable<TChunk>;
  isLiveCommitChunk: (chunk: TChunk) => boolean;
  graceMs?: number;
  onCacheError?: (error: unknown) => void;
  onWinner?: (winner: HedgeWinner) => void;
}

type CacheOutcome<T> = { kind: 'cache'; result: CacheLookupResult<T> } | { kind: 'cache-error' };

const DEFAULT_GRACE_MS = 25;

function closeLive<T>(controller: AbortController, iterator?: AsyncIterator<T>): void {
  controller.abort(new Error('cache won delayed stream hedge'));
  if (iterator?.return) {
    void Promise.resolve(iterator.return()).catch(() => undefined);
  }
}

export function delayedCacheStreamHedge<TCache, TChunk>(
  options: DelayedCacheStreamHedgeOptions<TCache, TChunk>
): AsyncIterable<TChunk> {
  const cacheOutcome = Promise.resolve()
    .then(options.readCache)
    .then<CacheOutcome<TCache>>((result) => ({ kind: 'cache', result }))
    .catch<CacheOutcome<TCache>>((error: unknown) => {
      options.onCacheError?.(error);
      return { kind: 'cache-error' };
    });

  return (async function* hedgedStream(): AsyncGenerator<TChunk> {
    let winner: HedgeWinner | null = null;
    const lockWinner = (candidate: HedgeWinner): boolean => {
      if (winner !== null) return winner === candidate;
      winner = candidate;
      options.onWinner?.(candidate);
      return true;
    };

    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const graceElapsed = new Promise<{ kind: 'grace' }>((resolve) => {
      graceTimer = setTimeout(
        () => resolve({ kind: 'grace' }),
        options.graceMs ?? DEFAULT_GRACE_MS
      );
    });
    const initial = await Promise.race([cacheOutcome, graceElapsed]);
    if (graceTimer) clearTimeout(graceTimer);

    if (initial.kind === 'cache' && initial.result.hit) {
      lockWinner('cache');
      yield* options.createCached(initial.result.value);
      return;
    }

    const liveController = new AbortController();
    const livePromise = options.createLive(liveController.signal);

    if (initial.kind !== 'grace') {
      lockWinner('live');
      yield* await livePromise;
      return;
    }

    const liveCreated = livePromise.then((iterable) => ({
      kind: 'live-created' as const,
      iterable,
    }));
    const creationWinner = await Promise.race([cacheOutcome, liveCreated]);
    if (creationWinner.kind === 'cache' && creationWinner.result.hit && lockWinner('cache')) {
      closeLive(liveController);
      void livePromise
        .then((iterable) => iterable[Symbol.asyncIterator]().return?.())
        .catch(() => undefined);
      yield* options.createCached(creationWinner.result.value);
      return;
    }

    const live =
      creationWinner.kind === 'live-created' ? creationWinner.iterable : await livePromise;
    const iterator = live[Symbol.asyncIterator]();
    const buffered: TChunk[] = [];
    let cachePending = creationWinner.kind === 'live-created';

    try {
      while (winner === null) {
        const nextPromise = iterator.next();
        const raceResult = cachePending
          ? await Promise.race([
              cacheOutcome,
              nextPromise.then((next) => ({ kind: 'live-next' as const, next })),
            ])
          : { kind: 'live-next' as const, next: await nextPromise };

        if (raceResult.kind === 'cache' || raceResult.kind === 'cache-error') {
          cachePending = false;
          if (raceResult.kind === 'cache' && raceResult.result.hit && lockWinner('cache')) {
            closeLive(liveController, iterator);
            yield* options.createCached(raceResult.result.value);
            return;
          }

          lockWinner('live');
          const next = await nextPromise;
          if (!next.done) buffered.push(next.value);
          break;
        }

        if (raceResult.next.done) {
          lockWinner('live');
          break;
        }

        buffered.push(raceResult.next.value);
        if (options.isLiveCommitChunk(raceResult.next.value)) {
          lockWinner('live');
          break;
        }
      }

      for (const chunk of buffered) yield chunk;
      if (winner === 'live') {
        while (true) {
          const next = await iterator.next();
          if (next.done) break;
          yield next.value;
        }
      }
    } catch (error) {
      liveController.abort(error);
      throw error;
    }
  })();
}
