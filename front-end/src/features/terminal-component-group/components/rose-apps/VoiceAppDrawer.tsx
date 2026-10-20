/**
 * STATE MACHINE: VoiceAppDrawer
 *
 *   [CLOSED] <--> [OPEN]  (owned by RoseAppsProvider.openApp === 'voice')
 *   The body (orbs, labels, persona) renders from the first open onward, so
 *   a never-opened drawer adds no voice labels or videos to the page.
 *
 *   VOICE (shared with the app-bar orb via useSelectedVoice):
 *   [ROSE] | [SERAPH] | [WYATT] --click orb--> that voice
 *   selected label: bold dark; others: grey. No ring/tile around the orbs.
 *
 *   PERSONA (User.customSystemPrompt, same field as Settings → Personality):
 *   [LOADING] --GET /user-settings ok--> [READY(value)]
 *   [LOADING] --not signed in / error--> [READY('')] (local only)
 *   [READY] --type--> [DIRTY] --blur--> PATCH /user-settings --> [READY]
 */

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { fetchPersona, savePersona } from '@/lib/api';
import { AppDrawerShell } from './AppDrawerShell';
import { useRoseApps } from './roseAppsState';
import { RoseVoiceOrb } from './RoseVoiceOrb';
import { VOICE_PRESETS, useSelectedVoice } from './voicePresets';

const PERSONA_MAX_LENGTH = 2000;

function usePersona(enabled: boolean) {
  const [persona, setPersona] = useState('');
  const savedRef = useRef('');
  const loadedRef = useRef(false);
  useEffect(() => {
    if (!enabled || loadedRef.current) return;
    loadedRef.current = true;
    let cancelled = false;
    fetchPersona()
      .then((value) => {
        if (cancelled) return;
        savedRef.current = value;
        setPersona(value);
      })
      .catch(() => {
        // Signed out or unavailable: the field stays local until next open.
        loadedRef.current = false;
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  const commit = () => {
    if (persona === savedRef.current) return;
    const next = persona;
    savePersona(next)
      .then(() => {
        savedRef.current = next;
      })
      .catch((error: unknown) => console.error('[VoiceApp] Failed to save persona:', error));
  };
  return { persona, setPersona, commit };
}

export function VoiceAppDrawer() {
  const apps = useRoseApps();
  const [voice, setVoice] = useSelectedVoice();
  const open = apps?.openApp === 'voice';
  const { persona, setPersona, commit } = usePersona(open);
  const [everOpened, setEverOpened] = useState(false);
  if (open && !everOpened) setEverOpened(true);
  if (apps === null) return null;
  if (!everOpened) {
    return <AppDrawerShell open={false} label="Voice drawer" testId="voice-app-drawer" />;
  }
  const hue = VOICE_PRESETS.find((v) => v.id === voice)?.hue ?? 0;
  return (
    <AppDrawerShell open={open} label="Voice drawer" testId="voice-app-drawer">
      <div className="flex items-center gap-2.5 border-b border-gray-200/90 px-3.5 py-3 text-[13px]">
        <RoseVoiceOrb size={22} hue={hue} />
        <b className="font-semibold">Voice</b>
        <button
          type="button"
          aria-label="Close voice"
          onClick={apps.closeApp}
          className="ml-auto rounded p-1 text-[hsl(240_8%_45%)] transition-colors hover:bg-muted"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-[26px] overflow-y-auto p-6">
        <div role="radiogroup" aria-label="Voice" className="flex gap-[34px]">
          {VOICE_PRESETS.map((preset) => {
            const selected = preset.id === voice;
            return (
              <button
                key={preset.id}
                type="button"
                role="radio"
                aria-checked={selected}
                data-testid={`voice-option-${preset.id}`}
                onClick={() => setVoice(preset.id)}
                className="flex flex-col items-center gap-2.5 text-[13px] focus-visible:outline-none"
                style={{
                  color: selected ? 'hsl(240 15% 8%)' : 'hsl(240 8% 45%)',
                  fontWeight: selected ? 600 : 400,
                }}
              >
                <RoseVoiceOrb size={96} hue={preset.hue} mic />
                {preset.label}
              </button>
            );
          })}
        </div>
        <label className="w-full max-w-[380px] text-xs text-[hsl(240_8%_45%)]">
          Persona
          <textarea
            data-testid="voice-persona"
            value={persona}
            maxLength={PERSONA_MAX_LENGTH}
            rows={2}
            placeholder="Warm, direct, a little funny. Keeps updates short."
            onChange={(e) => setPersona(e.target.value)}
            onBlur={commit}
            className="mt-1.5 block w-full resize-none rounded-[10px] border border-gray-200/90 px-3 py-2.5 text-[13px] text-[hsl(240_15%_8%)] outline-none focus:border-gray-300"
          />
        </label>
      </div>
    </AppDrawerShell>
  );
}
