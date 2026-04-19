// Thin barrel re-exporting the split api submodules.
// The implementation lives in src/lib/api/*.ts. Import sites across the
// codebase continue to reference '@/lib/api' unchanged.
export * from './api/index';
