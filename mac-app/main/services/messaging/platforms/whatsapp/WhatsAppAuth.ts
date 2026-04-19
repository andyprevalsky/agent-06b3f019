/**
 * Legacy entry-point shim — the WhatsAppAuth implementation has moved to
 * `main/domains/messaging-whatsapp/repo.ts`. This shim is preserved so the
 * existing blackbox test module graph (vi.mock paths + direct imports)
 * resolves identically after the layered refactor.
 */
export { WhatsAppAuth } from '../../../../domains/messaging-whatsapp/repo';
