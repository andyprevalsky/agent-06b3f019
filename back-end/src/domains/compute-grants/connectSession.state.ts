import type { PendingConnect } from './connectSession.types';

/** Shared state lives below the session/watcher/lifecycle modules to avoid cycles. */
export const pending = new Map<string, PendingConnect>();
