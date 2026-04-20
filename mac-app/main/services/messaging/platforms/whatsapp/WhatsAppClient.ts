/**
 * Legacy entry-point shim — the WhatsAppClient implementation has moved to
 * `main/domains/messaging-whatsapp/service.ts`. This shim is preserved so the
 * runtime layer (and blackbox tests via vi.mock) can still reference the
 * constructor at its original module specifier.
 */
export { WhatsAppClient } from '../../../../domains/messaging-whatsapp/service';
