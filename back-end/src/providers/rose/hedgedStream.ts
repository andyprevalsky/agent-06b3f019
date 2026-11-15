/**
 * Hedged racing of two chunk streams for latency-sensitive chat.
 *
 *   primary starts -> (no content by hedge signal) -> hedge starts in parallel
 *   first CONTENT chunk latches its branch as winner -> loser aborted
 *
 * Pre-content chunks are buffered per branch and replayed only for the winner,
 * so the caller never sees interleaved output from two providers. A branch
 * that errors before the latch simply drops out of the race; the race only
 * fails if every branch fails pre-latch.
 */

export interface HedgeBranch<T> {
  name: string;
  produce: (abortSignal: AbortSignal) => AsyncIterable<T>;
}

export interface HedgeParams<T> {
  primary: HedgeBranch<T>;
  hedge: HedgeBranch<T>;
  /** Resolves when the hedge branch should start (unless already latched). */
  hedgeAfter: () => Promise<void>;
  /** First chunk for which this is true latches its branch as the winner. */
  isContent: (item: T) => boolean;
  onWinner?: (name: string) => void;
  /**
   * A branch failed before any branch latched (and not because the race
   * aborted it). Pre-latch failures are otherwise swallowed, so this is the
   * only record of which guard ended a branch.
   */
  onBranchFailure?: (name: string, error: unknown) => void;
  /**
   * Start the hedge at once when the primary fails before it, instead of
   * rethrowing. Use when the hedge is itself the fallover for primary errors.
   */
  hedgeOnPrimaryFailure?: boolean;
  /**
   * Called once per branch that lost to a latched winner, with every item it
   * produced (before and after the latch, until its abort took effect),
   * including a branch that finished pre-latch (ended empty or failed). The
   * caller never sees these items; this is their only record (archive).
   */
  onLoser?: (name: string, items: readonly T[]) => void;
  /**
   * Called once when the race settles with a promise that resolves after every
   * started branch has finished (aborted losers included), so an archive writer
   * can wait for late onLoser reports without delaying the caller's stream.
   */
  onDrained?: (drained: Promise<void>) => void;
}

interface BranchState<T> {
  name: string;
  buffer: T[];
  /** Items a branch produced after another branch latched (archive only). */
  lateItems: T[];
  done: boolean;
  failure: unknown;
  /** onLoser already received this branch's items. */
  reported: boolean;
  controller: AbortController;
}

/**
 * Race primary against a delayed hedge; yield only the winning branch's chunks.
 * A primary failure BEFORE the hedge starts is rethrown immediately (fast
 * provider errors belong to the caller's classified fallover chain) unless
 * `hedgeOnPrimaryFailure` is set; once the hedge is racing, the race plays out
 * and an all-fail outcome prefers the primary's failure.
 */
export async function* hedgeStreams<T>(params: HedgeParams<T>): AsyncIterable<T> {
  const states: BranchState<T>[] = [];
  let winner: BranchState<T> | null = null;
  let wake: (() => void) | null = null;
  const notify = (): void => {
    wake?.();
    wake = null;
  };
  const changed = (): Promise<void> =>
    new Promise((resolve) => {
      wake = resolve;
    });

  const reportLoser = (state: BranchState<T>): void => {
    if (winner === null || winner === state || !state.done || state.reported) return;
    state.reported = true;
    const items = [...state.buffer, ...state.lateItems];
    state.buffer = [];
    state.lateItems = [];
    if (items.length > 0) params.onLoser?.(state.name, items);
  };

  const runBranch = async (branch: HedgeBranch<T>, state: BranchState<T>): Promise<void> => {
    try {
      for await (const item of branch.produce(state.controller.signal)) {
        if (winner !== null && winner !== state) {
          state.lateItems.push(item);
          return; // lost; drain quietly
        }
        state.buffer.push(item);
        if (winner === null && params.isContent(item)) {
          winner = state;
          params.onWinner?.(state.name);
        }
        notify();
      }
    } catch (error) {
      // Post-latch winner failures surface via state.failure in the consumer
      // loop; rethrowing here would be an unobserved promise rejection.
      state.failure = error ?? new Error(`${state.name} failed`);
      if (winner === null && !state.controller.signal.aborted) {
        params.onBranchFailure?.(state.name, state.failure);
      }
    } finally {
      state.done = true;
      reportLoser(state);
      notify();
    }
  };

  const runs: Promise<void>[] = [];
  const startBranch = (branch: HedgeBranch<T>): { state: BranchState<T>; run: Promise<void> } => {
    const state: BranchState<T> = {
      name: branch.name,
      buffer: [],
      lateItems: [],
      done: false,
      failure: null,
      reported: false,
      controller: new AbortController(),
    };
    states.push(state);
    const run = runBranch(branch, state);
    runs.push(run);
    return { state, run };
  };

  const primary = startBranch(params.primary);
  // Once the race settles (winner drained, or a pre-latch failure was thrown),
  // a late hedge timer must not launch an orphaned provider request.
  let settled = false;
  const armHedge = (): void => {
    if (!settled && states.length === 1 && winner === null) startBranch(params.hedge);
  };
  void params
    .hedgeAfter()
    .catch(() => undefined) // a broken delay arms the hedge immediately
    .then(() => {
      armHedge();
      notify();
    });

  try {
    // Wait for a latch, replaying the winner's buffer, then stream it live.
    let consumed = 0;
    for (;;) {
      if (winner !== null) {
        const active: BranchState<T> = winner;
        for (const state of states) {
          if (state !== active) state.controller.abort(new Error('lost chat hedge race'));
        }
        while (consumed < active.buffer.length) yield active.buffer[consumed++];
        if (consumed > 0) {
          // Drop the emitted prefix so a long winning stream doesn't
          // accumulate every chunk for its whole life.
          active.buffer.splice(0, consumed);
          consumed = 0;
        }
        if (active.done) {
          if (active.failure !== null) throw active.failure;
          return;
        }
        await changed();
        continue;
      }

      // A primary that fails BEFORE the hedge exists exits the race
      // immediately: fast provider errors (402 quota, 429, 5xx) must reach the
      // caller's error-classified fallover chain (e.g. same-model GLM-4.7 via
      // OpenRouter for quota) rather than silently racing the generic hedge,
      // unless the caller declared the hedge to be that fallover.
      // A primary that ends CLEANLY empty can never win, so the hedge starts
      // right away instead of waiting out the delay. Once racing, the race is
      // played out.
      if (primary.state.done && states.length === 1) {
        if (primary.state.failure !== null && !params.hedgeOnPrimaryFailure) {
          throw primary.state.failure;
        }
        armHedge();
      }
      if (states.length > 1 && states.every((state) => state.done)) {
        // No branch produced content. Prefer the primary failure for the
        // caller's existing error-classified fallover chain; fall back to the
        // hedge failure, then to a generic empty-stream signal.
        throw (
          primary.state.failure ??
          states.at(1)?.failure ??
          new Error('hedged stream ended without content')
        );
      }
      await changed();
    }
  } finally {
    settled = true;
    for (const state of states) {
      // A branch that finished before the latch (empty or failed) is reported
      // here; one still running reports when its abort lands.
      reportLoser(state);
      if (!state.done) state.controller.abort(new Error('chat hedge race settled'));
    }
    params.onDrained?.(Promise.allSettled(runs).then(() => undefined));
  }
}
