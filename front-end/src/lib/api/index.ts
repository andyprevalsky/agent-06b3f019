// Barrel: re-exports the full public API surface of @/lib/api.
// Consumers should keep importing from '@/lib/api' - this module preserves
// the legacy module shape while the implementation lives in sub-modules.

export * from './types';
export * from './agents';
export * from './messages';
export * from './attention';
export * from './browser-session';
export * from './invites';
export * from './people';
export * from './signals';
export * from './tree';
export * from './blueprints';
export * from './phones';
