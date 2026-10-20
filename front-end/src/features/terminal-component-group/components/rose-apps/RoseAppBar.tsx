/**
 * STATE MACHINE: RoseAppBar (right app bar)
 *
 *   [IDLE]       all app icons grey
 *   --click Browser--> [BROWSER_OPEN] globe turns #e8507f, Browser drawer slides in
 *   --click Voice----> [VOICE_OPEN]   orb's mic turns #e8507f, Voice drawer slides in
 *   --click the open app again--> [IDLE]
 *
 * Mirrors the left sidebar: fixed to the right edge, 64px, solid white with a
 * light left border. Apps are bare icons — no tiles, chips, rings or pills;
 * the open app is shown by color only. Hidden below md (mobile reaches the
 * browser through the chips, which open the bottom sheet).
 */

import { Globe } from 'lucide-react';
import { useRoseApps, type RoseApp } from './roseAppsState';
import { APP_BAR_WIDTH } from './roseAppsLayout';
import { RoseVoiceOrb } from './RoseVoiceOrb';
import { VOICE_PRESETS, useSelectedVoice } from './voicePresets';

export const APP_ACTIVE_COLOR = '#e8507f';

function AppButton({
  app,
  label,
  active,
  onClick,
  children,
}: {
  app: RoseApp;
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={`rose-app-${app}`}
      aria-label={label}
      title={`${label} app`}
      aria-pressed={active}
      onClick={onClick}
      className="grid h-[34px] w-[34px] cursor-pointer place-items-center focus-visible:outline-none"
      style={{ color: active ? APP_ACTIVE_COLOR : 'hsl(240 8% 45%)' }}
    >
      {children}
    </button>
  );
}

export function RoseAppBar() {
  const apps = useRoseApps();
  const [voice] = useSelectedVoice();
  if (apps === null) return null;
  const hue = VOICE_PRESETS.find((v) => v.id === voice)?.hue ?? 0;
  return (
    <nav
      aria-label="Apps"
      data-testid="rose-app-bar"
      className="fixed bottom-0 right-0 top-0 z-50 hidden flex-col items-center gap-[14px] border-l border-gray-200/60 bg-white pt-5 md:flex"
      style={{ width: APP_BAR_WIDTH }}
    >
      <AppButton
        app="browser"
        label="Browser"
        active={apps.openApp === 'browser'}
        onClick={() => apps.toggleApp('browser')}
      >
        <Globe className="h-[22px] w-[22px]" strokeWidth={1.7} />
      </AppButton>
      <AppButton
        app="voice"
        label="Voice"
        active={apps.openApp === 'voice'}
        onClick={() => apps.toggleApp('voice')}
      >
        <RoseVoiceOrb
          size={34}
          hue={hue}
          mic
          micColor={apps.openApp === 'voice' ? APP_ACTIVE_COLOR : '#ffffff'}
        />
      </AppButton>
    </nav>
  );
}
