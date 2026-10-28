/**
 * Fast Mode proxy call ordinals: the Nth call of a trace session records and
 * replays slot N. Every backend instance must draw from one sequence per
 * session, or two instances hand out the same slot and recordings overwrite
 * each other (S25). Production injects `sharedTraceOrdinalReserver`
 * (traceOrdinalShared.ts, Postgres); this module stays database-free so the
 * proxy cores remain pure and unit-testable.
 */

export interface TraceOrdinalReservation {
  ordinal: number;
  /** Give the ordinal back when the call consumed no slot and nothing was taken after it. */
  rollback: () => Promise<void>;
}

/** Reserve the next ordinal for `counterKey` (`<kind>:<traceHash>:<sessionId|default>`). */
export type ReserveTraceOrdinal = (counterKey: string) => Promise<TraceOrdinalReservation>;

/** A single-process reserver for unit tests of the pure proxy cores. */
export function createInMemoryTraceOrdinalReserver(): ReserveTraceOrdinal {
  const counters = new Map<string, number>();
  return async (counterKey) => {
    const ordinal = counters.get(counterKey) ?? 0;
    counters.set(counterKey, ordinal + 1);
    return {
      ordinal,
      rollback: async () => {
        if (counters.get(counterKey) !== ordinal + 1) return;
        if (ordinal === 0) counters.delete(counterKey);
        else counters.set(counterKey, ordinal);
      },
    };
  };
}
