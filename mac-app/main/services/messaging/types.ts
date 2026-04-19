/**
 * Compatibility shim — the real types layer lives in
 * main/domains/messaging-core/types.ts.
 *
 * This file remains because the messaging-core blackbox and a handful of
 * consumers import from the stable path `main/services/messaging/types`.
 * Do not add new types here — edit the domain layer and re-export.
 */

export * from '../../domains/messaging-core/types';
