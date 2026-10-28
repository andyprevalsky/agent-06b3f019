/**
 * Cross-instance Fast Mode proxy ordinals: one Postgres sequence row per trace
 * session in SharedEphemeralState (one UPSERT per proxied call, contended only
 * by the session's own sequential calls).
 */
import { nextSequenceValue, releaseSequenceValue } from './sharedState';
import type { ReserveTraceOrdinal } from './traceOrdinal';

const NAMESPACE = 'fast-mode-trace-ordinal';
/** A recording or replay session outlives a single agent run; each call extends it. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const sharedTraceOrdinalReserver: ReserveTraceOrdinal = async (counterKey) => {
  const reservation = await nextSequenceValue(NAMESPACE, counterKey, SESSION_TTL_MS);
  return {
    ordinal: reservation.value,
    rollback: () => releaseSequenceValue(NAMESPACE, counterKey, reservation),
  };
};
