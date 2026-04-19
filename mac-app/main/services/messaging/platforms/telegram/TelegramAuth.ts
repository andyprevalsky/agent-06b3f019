/**
 * Legacy import shim — logic moved to main/domains/messaging-telegram/repo.ts.
 * Kept so existing consumers (blackbox tests, other services) resolve the class.
 */
export { TelegramAuth } from '../../../../domains/messaging-telegram/repo';
