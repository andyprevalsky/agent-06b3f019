/**
 * Compatibility barrel — re-exports the messaging-core runtime layer.
 *
 * The real public surface lives in main/domains/messaging-core/runtime.ts.
 * Callers should import from here (`main/services/messaging`) only while we
 * keep the pre-refactor path stable for the blackbox tests that bind to it.
 */

export * from '../../domains/messaging-core/runtime';
