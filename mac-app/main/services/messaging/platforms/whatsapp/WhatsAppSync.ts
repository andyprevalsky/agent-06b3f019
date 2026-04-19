/**
 * Legacy entry-point shim — the WhatsAppSync coordinator has moved to
 * `main/domains/messaging-whatsapp/runtime.ts`. Re-exported here so existing
 * consumers (handlers/registry, SyncManager, blackbox tests) continue to
 * resolve the original module specifier.
 */
export { WhatsAppSync } from '../../../../domains/messaging-whatsapp/runtime';
