/**
 * Legacy entry path for the batch-uploader domain.
 *
 * The implementation lives in `main/domains/batch-uploader/`; this shim
 * preserves the pre-refactor import path for callers (handlers/registry,
 * sibling sync domains, blackbox tests) without forcing them to update
 * their imports.
 */

export { BatchUploader } from '../domains/batch-uploader/runtime';
