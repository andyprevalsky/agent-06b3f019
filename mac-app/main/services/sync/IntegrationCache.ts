/**
 * Re-export shim — IntegrationCache lives in the layered domain now.
 * Sibling services (iMessageSync, cookieSync, browserStateSync, WhatsAppSync,
 * TelegramSync, claudeCredentialSync, handlers/registry) still import from
 * this path, so it forwards to the service layer.
 */
export { IntegrationCache } from '../../domains/sync-manager/service';
