/**
 * Entry path for the phone-mirroring domain used by SyncManager.
 *
 * The implementation lives in `main/domains/phone-mirroring/`; this shim lets
 * the sync coordinator start/stop it without a cross-domain import.
 */

export { PhoneMirroring } from '../domains/phone-mirroring/runtime';
