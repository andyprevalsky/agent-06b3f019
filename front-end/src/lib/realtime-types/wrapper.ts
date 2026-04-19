// =============================================================================
// Raw Supabase Realtime Wrapper
// =============================================================================

/**
 * Raw wrapper structure from Supabase Realtime broadcast.
 * All broadcast messages arrive in this format.
 */
export interface RealtimeBroadcastWrapper<T> {
  payload: {
    record: T;
  };
}
