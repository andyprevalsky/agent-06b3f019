/**
 * Shim kept for `research/tests/rose-api-keys.test.ts`, which imports
 * `createHandler` from this path. The implementation lives in
 * `research/domains/generate-api-key/`.
 */

export { createHandler } from '../../../domains/generate-api-key/runtime.ts';
