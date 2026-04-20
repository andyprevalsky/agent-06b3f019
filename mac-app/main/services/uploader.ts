/**
 * Re-export shim — Uploader lives in the layered domain now.
 * External consumers (batchUploader.ts, blackbox tests) still import from
 * this path, so it forwards to the runtime layer.
 */
export { Uploader } from '../domains/uploader/runtime';
