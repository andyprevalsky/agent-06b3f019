/**
 * Speed level for the Rose Desktop speed toggle (normal → fast → ultra).
 *
 *   [NORMAL] --click--> [FAST] --click--> [ULTRA] --click--> [NORMAL]
 *      │                    │                   │
 *      ▼                    ▼                   ▼
 *   speed: standard      speed: fast        speed: ultrafast   (create-agent payload)
 *
 * The parent owns the on/off boolean; the fast-vs-ultra choice is remembered
 * per account in browser/Electron storage. Ultrafast requires an explicit
 * selection; an unset preference starts at Fast. The create-agent request
 * carries only `speed`; speed never turns any cache on or off.
 */

import { useQueryPreference } from '@/hooks/useQueryPreference';
import { writeQueryPreferences } from '@/lib/queryPreferences';
import { useSyncExternalStore } from 'react';

export type SpeedLevel = 'normal' | 'fast' | 'ultra';

export type AgentSpeed = 'standard' | 'fast' | 'ultrafast';

export function agentSpeedForLevel(level: SpeedLevel): AgentSpeed {
  const speeds: Record<SpeedLevel, AgentSpeed> = {
    normal: 'standard',
    fast: 'fast',
    ultra: 'ultrafast',
  };
  return speeds[level];
}

export const SPEED_LEVELS: readonly SpeedLevel[] = ['normal', 'fast', 'ultra'];

export const SPEED_LABELS: Record<SpeedLevel, string> = {
  normal: 'Normal speed',
  fast: 'Fast',
  ultra: 'Ultrafast',
};

let ultraPreferred = false;
const listeners = new Set<() => void>();
const displayedUltra = new Map<string, boolean>();
let revision = 0;

function notify(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

/** Selected-agent display only; never writes an account preference. */
export function setDisplayedUltraPreferred(value: boolean | null, userId?: string | null): void {
  const key = userId ?? '';
  if (value === null) {
    if (displayedUltra.delete(key)) notify();
  } else if (displayedUltra.get(key) !== value) {
    displayedUltra.set(key, value);
    notify();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): number {
  return revision;
}

export function setUltraPreferred(value: boolean, userId?: string | null): void {
  if (displayedUltra.has(userId ?? '')) setDisplayedUltraPreferred(value, userId);
  if (userId) {
    writeQueryPreferences(userId, { ultraPreferred: value });
    return;
  }
  if (ultraPreferred === value) return;
  ultraPreferred = value;
  notify();
}

/** Test-only: restore the session default (fast) between suites. */
export function resetSpeedLevelSession(): void {
  displayedUltra.clear();
  ultraPreferred = false;
  notify();
}

export function useUltraPreferred(userId?: string | null): boolean {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [saved] = useQueryPreference(userId, 'ultraPreferred', false);
  return displayedUltra.get(userId ?? '') ?? (userId ? (saved ?? false) : ultraPreferred);
}

export function speedLevelOf(fastMode: boolean, ultra: boolean): SpeedLevel {
  if (!fastMode) return 'normal';
  return ultra ? 'ultra' : 'fast';
}

export function nextSpeedLevel(level: SpeedLevel): SpeedLevel {
  return SPEED_LEVELS[(SPEED_LEVELS.indexOf(level) + 1) % SPEED_LEVELS.length]!;
}
