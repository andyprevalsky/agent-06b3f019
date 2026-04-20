/**
 * Legacy import shim — logic moved to main/domains/messaging-telegram/runtime.ts.
 * Kept so existing consumers (blackbox tests, other services) resolve the class.
 */
export { TelegramSync } from '../../../../domains/messaging-telegram/runtime';
