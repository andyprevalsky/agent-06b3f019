/**
 * Legacy entry-point shim — the IMessageWatcher implementation has moved to
 * `main/domains/messaging-imessage/service.ts`. This shim is preserved so the
 * existing blackbox test module graph (vi.mock paths + direct imports from
 * i-message-sync) resolves identically after the layered refactor.
 */
export { IMessageWatcher } from '../../../../domains/messaging-imessage/service';
