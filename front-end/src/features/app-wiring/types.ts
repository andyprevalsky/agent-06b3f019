import type { ComponentType } from 'react';

/** A single entry in the application route table. */
export interface RouteEntry {
  readonly path: string;
  readonly component: ComponentType;
  /** When true, this route is the catch-all 404 fallback. */
  readonly isCatchAll?: boolean;
}
