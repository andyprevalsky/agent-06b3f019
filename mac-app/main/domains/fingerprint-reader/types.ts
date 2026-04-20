/**
 * Types for the fingerprint-reader domain.
 *
 * The public payload shape (`FingerprintData`) is owned by
 * `shared/types/ipc.ts` because it crosses the IPC boundary. We re-export it
 * here so service/runtime callers import domain-local types instead of
 * reaching into `shared/types`.
 */

export type { FingerprintData } from '../../../shared/types/ipc';
