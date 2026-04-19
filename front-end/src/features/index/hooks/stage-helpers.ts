/**
 * Pure helpers for the FeatureVideoStage state machine.
 *
 * Kept free of React to simplify unit testing and keep the main hook small.
 */

import type { FeatureKey, MarkersFile, Segment } from '../types';

export type StageMode =
  | 'idle'
  | 'ramping'
  | 'awaitOutro'
  | 'seeking'
  | 'customAwaitWindow'
  | 'customOutroPlaying';

export type CustomWindowName = 'anthropic' | 'meta' | 'deepseak' | 'gemini' | 'oai';

export interface CustomWindow {
  name: CustomWindowName;
  start: number;
  end: number;
  mStart?: number;
  mEnd?: number;
}

export interface CustomPlan {
  windows: CustomWindow[];
  targetKey: FeatureKey;
  chosen?: {
    validStart: number;
    validEnd: number;
    outroStart: number;
    outroEnd: number;
  };
}

export const FEATURE_KEYS: readonly FeatureKey[] = [
  'customization',
  'conversations',
  'engine',
  'memory',
  'privacy',
] as const;

/** Figure out which feature segment + part `t` falls in. */
export function findContainingFeature(
  markers: MarkersFile,
  t: number,
): { key: FeatureKey; part: 'intro' | 'cycle' | 'outro' | 'none' } {
  for (const key of FEATURE_KEYS) {
    const s = markers[key];
    if (t >= s.introStart && t < s.introEnd) return { key, part: 'intro' };
    if (t >= s.introEnd && t < s.outroStart) return { key, part: 'cycle' };
    if (t >= s.outroStart && t < s.outroEnd + 0.0001) return { key, part: 'outro' };
  }
  return { key: 'engine', part: 'none' };
}

/** Windows (in frames) used to pick a unique customization outro on feature-switch. */
export function buildCustomWindows(cz: Segment): CustomWindow[] {
  return [
    {
      name: 'anthropic',
      start: 70,
      end: 110,
      mStart: cz.outroAnthropicStart,
      mEnd: cz.outroAnthropicEnd,
    },
    { name: 'meta', start: 150, end: 190, mStart: cz.outroMetaStart, mEnd: cz.outroMetaEnd },
    {
      name: 'deepseak',
      start: 230,
      end: 270,
      mStart: cz.outroDeepseakStart,
      mEnd: cz.outroDeepseakEnd,
    },
    { name: 'gemini', start: 310, end: 350, mStart: cz.outroGeminiStart, mEnd: cz.outroGeminiEnd },
    // oai uses generic outroStart/End
    { name: 'oai', start: 390, end: 430, mStart: cz.outroStart, mEnd: cz.outroEnd },
  ];
}

/**
 * Shift seek targets slightly earlier on HEVC/iOS Safari for engine/memory so we
 * don't land past the intro's presentation boundary.
 */
export function computeSeekForKey(options: {
  key: FeatureKey | null;
  baseTime: number;
  fps: number;
  isIOSSafari: boolean;
  memoryOffsetFrames: number;
}): number {
  const { key, baseTime, fps, isIOSSafari, memoryOffsetFrames } = options;
  try {
    if (!isIOSSafari) return baseTime;
    if (key !== 'engine' && key !== 'memory') return baseTime;
    const frameSec = 1 / (fps || 30);
    if (key === 'memory') {
      const framesEarlier = Math.max(0, memoryOffsetFrames || 0);
      const tinyOffset = 0.003;
      let t = Math.max(0, baseTime - framesEarlier * frameSec + tinyOffset);
      if (t <= 0.01) t = 0.0;
      return t;
    }
    // engine
    let t = Math.max(0, baseTime - 1.0 * frameSec);
    if (t <= 0.01) t = 0.0;
    return t;
  } catch {
    return baseTime;
  }
}

/** Normalize a markers object to a stable shape. */
export function normalizeMarkers(markers: MarkersFile | null): MarkersFile | null {
  if (!markers) return null;
  return {
    fps: markers.fps,
    customization: markers.customization,
    conversations: markers.conversations,
    engine: markers.engine,
    memory: markers.memory,
    privacy: markers.privacy,
  };
}

/** Detect Safari / iOS from a UA string. */
export function detectPlatform(userAgent: string): { isSafari: boolean; isIOS: boolean } {
  const ua = userAgent.toLowerCase();
  const isSafari = ua.includes('safari') && !ua.includes('chrome') && !ua.includes('firefox');
  const isIOS = /iphone|ipad|ipod/.test(ua);
  return { isSafari, isIOS };
}
