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
}

interface BranchState<T> {
  name: string;
  buffer: T[];
  done: boolean;
  failure: unknown;
  controller: AbortController;
}

/**
 * Race primary against a delayed hedge; yield only the winning branch's chunks.
 * Throws the primary branch's failure when every started branch fails pre-latch.
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

  const runBranch = async (branch: HedgeBranch<T>, state: BranchState<T>): Promise<void> => {
    try {
      for await (const item of branch.produce(state.controller.signal)) {
        if (winner !== null && winner !== state) return; // lost; drain quietly
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
    } finally {
      state.done = true;
      notify();
    }
  };

  const startBranch = (branch: HedgeBranch<T>): { state: BranchState<T>; run: Promise<void> } => {
    const state: BranchState<T> = {
      name: branch.name,
      buffer: [],
      done: false,
      failure: null,
      controller: new AbortController(),
    };
    states.push(state);
    return { state, run: runBranch(branch, state) };
  };

  const primary = startBranch(params.primary);
  const armHedge = (): void => {
    if (states.length === 1 && winner === null) startBranch(params.hedge);
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
        if (active.done) {
          if (active.failure !== null) throw active.failure;
          return;
        }
        await changed();
        continue;
      }

      const primaryOut = primary.state.done && primary.state.failure !== null;
      if (primaryOut) armHedge();
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
    for (const state of states) {
      if (!state.done) state.controller.abort(new Error('chat hedge race settled'));
    }
  }
}
