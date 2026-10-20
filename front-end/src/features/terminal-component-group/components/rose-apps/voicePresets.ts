/**
 * Voice presets for the Voice app. Names, ElevenLabs voice ids and hue-rotate
 * offsets mirror mac-app/ui/features/onboarding/components/VoiceSelector.tsx.
 *
 * The selection is local (localStorage) for now.
 * TODO(rose-user-ui): persist the chosen voice on the user record once the
 * backend exposes a voice field; the mac app's onboarding owns it today.
 */

import { useCallback, useSyncExternalStore } from 'react';

export type VoiceId = 'rose' | 'seraph' | 'wyatt';

export interface VoicePreset {
  id: VoiceId;
  label: string;
  voiceId: string;
  hue: number;
}

export const VOICE_PRESETS: VoicePreset[] = [
  { id: 'rose', label: 'Rose', voiceId: '6fZce9LFNG3iEITDfqZZ', hue: 0 },
  { id: 'seraph', label: 'Seraph', voiceId: 'J2FGlQG8Gd7x8uEDt2H8', hue: 190 },
  { id: 'wyatt', label: 'Wyatt', voiceId: 'YXpFCvM1S3JbWEJhoskW', hue: 100 },
];

const STORAGE_KEY = 'rose-voice';
const listeners = new Set<() => void>();
let memoryVoice: VoiceId = 'rose';

function readVoice(): VoiceId {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return VOICE_PRESETS.some((v) => v.id === stored) ? (stored as VoiceId) : memoryVoice;
  } catch {
    return memoryVoice;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Shared selected voice (app bar orb + Voice drawer stay in sync). */
export function useSelectedVoice(): [VoiceId, (voice: VoiceId) => void] {
  const voice = useSyncExternalStore(subscribe, readVoice, () => 'rose' as VoiceId);
  const setVoice = useCallback((next: VoiceId) => {
    memoryVoice = next;
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // storage unavailable (private mode): memoryVoice still carries the choice
    }
    listeners.forEach((listener) => listener());
  }, []);
  return [voice, setVoice];
}
