/**
 * Supabase Realtime Message Types - barrel.
 *
 * The legacy monolithic `src/lib/realtime-types.ts` was split into focused
 * submodules. Every public symbol is re-exported here, so existing consumers
 * can keep importing from `@/lib/realtime-types`.
 *
 * Submodules:
 *   wrapper           - RealtimeBroadcastWrapper (raw Supabase envelope)
 *   message-metadata  - MessageMetadata + MessageRole/ToolStatus/action enums
 *   tool-metadata     - BaseToolMetadata + tool-specific metadata unions
 *   message-payloads  - Insert/Update/Delete/ToolMessage payloads
 *   stream-payloads   - Assistant/Plan/Tool/Attention/AgentMode stream payloads
 *   bus-channel       - AgentStateChangedPayload + FailureContext/TrajectoryStep
 *   user-channel      - AttentionRequestPayload (deprecated)
 *   handlers          - Channel handler shapes
 *   guards            - is* type guards
 *   validators        - shape validators (internal helpers used by extractors)
 *   extractors        - extract* wrapper parsers
 */

export * from './wrapper';
export * from './message-metadata';
export * from './tool-metadata';
export * from './message-payloads';
export * from './stream-payloads';
export * from './bus-channel';
export * from './user-channel';
export * from './handlers';
export * from './guards';
export * from './extractors';
