/**
 * STATE MACHINE: VoiceSelector
 *
 *   [PRESET 0..2] ─(arrow / dot)→ change slot ─(fetch preview)→ play audio
 *   [PRESET 0..2] ─(arrow / dot to slot 3)→ [CUSTOM]
 *   [CUSTOM] ─(paste id)→ fetch preview → play audio
 *   [CUSTOM] ─(arrow / dot)→ [PRESET *]
 *
 * Slot 3 of the carousel is "Custom" — selecting it shows the ElevenLabs
 * voice-ID input inline in the same panel.
 */

import { useEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react';
import VoiceOrb from './VoiceOrb';

const ELEVENLABS_LIBRARY_URL = 'https://elevenlabs.io/app/voice-library';

const openVoiceLibrary = (): void => {
  if (typeof window === 'undefined') return;
  const api = window.api as { openExternal?: (url: string) => Promise<void> } | undefined;
  if (api?.openExternal !== undefined) {
    void api.openExternal(ELEVENLABS_LIBRARY_URL);
    return;
  }
  window.open(ELEVENLABS_LIBRARY_URL, '_blank', 'noopener,noreferrer');
};

export interface VoicePreference {
  mode: 'preset' | 'custom';
  voiceId: string;
  label: string;
}

interface PresetVoice {
  label: string;
  voiceId: string;
  hue: number;
}

// Hue values are CSS hue-rotate offsets applied to the warm-toned orb video.
// 0 leaves the source colors (peach/yellow), ~190 shifts to blue, ~100 to
// green, ~270 to purple. The orb video source is /voice-orb.mp4.
const PRESET_VOICES: readonly PresetVoice[] = [
  { label: 'Rose', voiceId: '6fZce9LFNG3iEITDfqZZ', hue: 0 },
  { label: 'Seraph', voiceId: 'J2FGlQG8Gd7x8uEDt2H8', hue: 190 },
  { label: 'Wyatt', voiceId: 'YXpFCvM1S3JbWEJhoskW', hue: 100 },
] as const;

const CUSTOM_HUE = 270;
const CUSTOM_SLOT = PRESET_VOICES.length;
const TOTAL_SLOTS = PRESET_VOICES.length + 1;

export const DEFAULT_VOICE_PREFERENCE: VoicePreference = {
  mode: 'preset',
  voiceId: PRESET_VOICES[0].voiceId,
  label: PRESET_VOICES[0].label,
};

const findPresetIndex = (voiceId: string): number => {
  const idx = PRESET_VOICES.findIndex((v) => v.voiceId === voiceId);
  return idx === -1 ? 0 : idx;
};

// Preset samples are pre-generated MP3s shipped in mac-app/public/voice-samples/.
// Custom voices fall through to the backend, which fetches the ElevenLabs
// auto-generated preview_url for whatever voice ID the user pasted.
const presetSamplePath = (voiceId: string): string =>
  `/voice-samples/${encodeURIComponent(voiceId)}.mp3`;

async function fetchCustomPreviewUrl(voiceId: string): Promise<string | null> {
  try {
    const response = await fetch(`/api/voices/${encodeURIComponent(voiceId)}/preview`);
    if (!response.ok) return null;
    const body = (await response.json()) as { url?: string };
    return typeof body.url === 'string' ? body.url : null;
  } catch {
    return null;
  }
}

async function resolvePreviewUrl(voiceId: string, isCustom: boolean): Promise<string | null> {
  if (!isCustom) return presetSamplePath(voiceId);
  return fetchCustomPreviewUrl(voiceId);
}

interface VoiceSelectorProps {
  value: VoicePreference;
  customVoiceId: string;
  disabled: boolean;
  onChange: (value: VoicePreference) => void;
  onCustomVoiceIdChange: (value: string) => void;
}

function usePreviewAudio(
  isCustom: boolean,
  customVoiceId: string,
  preset: PresetVoice | null
): void {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastPlayedRef = useRef<string | null>(null);

  useEffect(() => {
    const id = isCustom ? customVoiceId.trim() : (preset as PresetVoice).voiceId;
    if (id === '' || id === lastPlayedRef.current) return;
    lastPlayedRef.current = id;
    let cancelled = false;
    void (async () => {
      const url = await resolvePreviewUrl(id, isCustom);
      if (cancelled || url === null) return;
      const audio = audioRef.current ?? new Audio();
      audioRef.current = audio;
      audio.pause();
      audio.src = url;
      audio.currentTime = 0;
      try {
        await audio.play();
      } catch {
        /* autoplay blocked / file missing — silent */
      }
    })();
    return () => {
      cancelled = true;
      if (audioRef.current !== null) audioRef.current.pause();
    };
  }, [isCustom, customVoiceId, preset]);
}

interface CarouselHeaderProps {
  slotLabel: string;
  activeSlot: number;
  disabled: boolean;
  selectSlot: (next: number) => void;
}

const CarouselHeader = ({
  slotLabel,
  activeSlot,
  disabled,
  selectSlot,
}: CarouselHeaderProps): JSX.Element => (
  <div className="flex items-center gap-3 select-none">
    <button
      type="button"
      aria-label="Previous voice"
      disabled={disabled}
      onClick={() => selectSlot(activeSlot - 1)}
      className="h-9 w-9 rounded-full text-foreground/60 hover:text-foreground transition-colors flex items-center justify-center disabled:opacity-30"
    >
      <ChevronLeft className="w-4 h-4" />
    </button>

    <div className="flex-1 text-center">
      <div className="text-lg font-medium tracking-tight text-foreground">{slotLabel}</div>
    </div>

    <button
      type="button"
      aria-label="Next voice"
      disabled={disabled}
      onClick={() => selectSlot(activeSlot + 1)}
      className="h-9 w-9 rounded-full text-foreground/60 hover:text-foreground transition-colors flex items-center justify-center disabled:opacity-30"
    >
      <ChevronRight className="w-4 h-4" />
    </button>
  </div>
);

interface SlotIndicatorsProps {
  activeSlot: number;
  disabled: boolean;
  selectSlot: (next: number) => void;
}

const SlotIndicators = ({ activeSlot, disabled, selectSlot }: SlotIndicatorsProps): JSX.Element => (
  <div
    className="flex items-center justify-center gap-1.5"
    role="tablist"
    aria-label="Voice options"
  >
    {PRESET_VOICES.map((p, idx) => (
      <button
        key={p.voiceId}
        type="button"
        role="tab"
        aria-selected={activeSlot === idx}
        aria-label={p.label}
        disabled={disabled}
        onClick={() => selectSlot(idx)}
        className={`h-1.5 rounded-full transition-all ${
          activeSlot === idx ? 'w-6 bg-foreground' : 'w-1.5 bg-foreground/25 hover:bg-foreground/50'
        }`}
      />
    ))}
    <button
      type="button"
      role="tab"
      aria-selected={activeSlot === CUSTOM_SLOT}
      aria-label="Custom"
      disabled={disabled}
      onClick={() => selectSlot(CUSTOM_SLOT)}
      className={`h-1.5 rounded-full transition-all ${
        activeSlot === CUSTOM_SLOT
          ? 'w-6 bg-foreground'
          : 'w-1.5 bg-foreground/25 hover:bg-foreground/50'
      }`}
    />
  </div>
);

interface CustomVoiceInputProps {
  customVoiceId: string;
  disabled: boolean;
  onCustomVoiceIdChange: (value: string) => void;
  onChange: (value: VoicePreference) => void;
}

const CustomVoiceInput = ({
  customVoiceId,
  disabled,
  onCustomVoiceIdChange,
  onChange,
}: CustomVoiceInputProps): JSX.Element => (
  <div className="space-y-2 pt-3 border-t border-border/40">
    <input
      id="customVoiceId"
      type="text"
      value={customVoiceId}
      disabled={disabled}
      placeholder="ElevenLabs voice ID"
      onChange={(event) => {
        const next = event.target.value;
        onCustomVoiceIdChange(next);
        onChange({ mode: 'custom', voiceId: next.trim(), label: 'Custom' });
      }}
      className="w-full h-9 rounded-lg border border-muted-foreground/30 bg-background px-3 text-sm outline-none focus:border-foreground"
    />
    <button
      type="button"
      onClick={openVoiceLibrary}
      className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
    >
      Browse the ElevenLabs voice library
      <ExternalLink className="w-3 h-3" />
    </button>
  </div>
);

const VoiceSelector = ({
  value,
  customVoiceId,
  disabled,
  onChange,
  onCustomVoiceIdChange,
}: VoiceSelectorProps): JSX.Element => {
  const isCustom = value.mode === 'custom';
  const activeSlot = isCustom ? CUSTOM_SLOT : findPresetIndex(value.voiceId);
  const preset = isCustom ? null : PRESET_VOICES[activeSlot];
  const hue = isCustom ? CUSTOM_HUE : (preset as PresetVoice).hue;
  const slotLabel = isCustom ? 'Custom' : (preset as PresetVoice).label;

  usePreviewAudio(isCustom, customVoiceId, preset);

  const selectSlot = (next: number): void => {
    const wrapped = ((next % TOTAL_SLOTS) + TOTAL_SLOTS) % TOTAL_SLOTS;
    if (wrapped === CUSTOM_SLOT) {
      onChange({ mode: 'custom', voiceId: customVoiceId.trim(), label: 'Custom' });
      return;
    }
    const target = PRESET_VOICES[wrapped];
    onChange({ mode: 'preset', voiceId: target.voiceId, label: target.label });
  };

  return (
    <div className="flex flex-col items-center gap-5">
      <div className="relative w-[300px] h-[300px] flex items-center justify-center">
        <div
          className="absolute inset-0 backdrop-blur-xl bg-background/40"
          style={{
            WebkitMaskImage:
              'radial-gradient(circle at center, black 0%, black 35%, transparent 75%)',
            maskImage: 'radial-gradient(circle at center, black 0%, black 35%, transparent 75%)',
          }}
        />
        <div className="relative">
          <VoiceOrb hue={hue} size={220} />
        </div>
      </div>

      <div className="w-[260px] rounded-2xl border border-border/50 backdrop-blur-xl bg-background/40 px-4 py-4 space-y-3">
        <CarouselHeader
          slotLabel={slotLabel}
          activeSlot={activeSlot}
          disabled={disabled}
          selectSlot={selectSlot}
        />
        <SlotIndicators activeSlot={activeSlot} disabled={disabled} selectSlot={selectSlot} />
        {isCustom ? (
          <CustomVoiceInput
            customVoiceId={customVoiceId}
            disabled={disabled}
            onCustomVoiceIdChange={onCustomVoiceIdChange}
            onChange={onChange}
          />
        ) : null}
      </div>
    </div>
  );
};

export default VoiceSelector;
