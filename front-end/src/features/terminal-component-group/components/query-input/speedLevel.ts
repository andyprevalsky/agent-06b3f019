/**
 * Speed level for the Rose Desktop speed toggle (normal → fast → ultra).
 *
 *   [NORMAL] --click--> [FAST] --click--> [ULTRA] --click--> [NORMAL]
 *
 * fast and ultra both send provider fast mode (the existing boolean the parent
 * owns); the fast-vs-ultra choice is a session-only preference kept here, never
 * persisted. It defaults to ultra, so an operator whose Fast Mode default is on
 * starts on Ultrafast.
 */

import { useSyncExternalStore } from 'react';

export type SpeedLevel = 'normal' | 'fast' | 'ultra';

export const SPEED_LEVELS: readonly SpeedLevel[] = ['normal', 'fast', 'ultra'];

export const SPEED_LABELS: Record<SpeedLevel, string> = {
  normal: 'Normal speed',
  fast: 'Fast',
  ultra: 'Ultrafast',
};

let ultraPreferred = true;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): boolean {
  return ultraPreferred;
}

export function setUltraPreferred(value: boolean): void {
  if (ultraPreferred === value) return;
  ultraPreferred = value;
  for (const listener of listeners) listener();
}

/** Test-only: restore the session default (ultra) between suites. */
export function resetSpeedLevelSession(): void {
  setUltraPreferred(true);
}

export function useUltraPreferred(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function speedLevelOf(fastMode: boolean, ultra: boolean): SpeedLevel {
  if (!fastMode) return 'normal';
  return ultra ? 'ultra' : 'fast';
}

export function nextSpeedLevel(level: SpeedLevel): SpeedLevel {
  return SPEED_LEVELS[(SPEED_LEVELS.indexOf(level) + 1) % SPEED_LEVELS.length]!;
}
