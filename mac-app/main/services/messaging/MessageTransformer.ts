/**
 * Compatibility shim — the real service lives in
 * main/domains/messaging-core/service.ts.
 *
 * Kept because the messaging-core blackbox and existing sync code import from
 * `main/services/messaging/MessageTransformer`. Do not add logic here.
 */

export { MessageTransformer } from '../../domains/messaging-core/service';
