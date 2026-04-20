/**
 * Legacy barrel shim — the real messaging-imessage public surface lives at
 * `main/domains/messaging-imessage/runtime.ts`. Kept here so blackbox tests
 * and messaging-core's own barrel that import from the stable path
 * `main/services/messaging/platforms/imessage` continue to resolve.
 */
export { IMessageWatcher } from '../../../../domains/messaging-imessage/runtime';
