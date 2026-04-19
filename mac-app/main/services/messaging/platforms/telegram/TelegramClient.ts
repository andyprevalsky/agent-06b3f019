/**
 * Legacy import shim — logic moved to main/domains/messaging-telegram/service.ts.
 * Kept so existing consumers (blackbox tests, other services) resolve the class.
 */
export { TelegramClient } from '../../../../domains/messaging-telegram/service';
