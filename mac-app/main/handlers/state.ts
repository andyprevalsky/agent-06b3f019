import Store from 'electron-store';
import type { ShortcutConfig } from '../../shared/types/ipc';

interface OnboardingState {
  isComplete: boolean;
  lastAuthProvider: string | null;
}

const onboardingStore = new Store<OnboardingState>({
  name: 'onboarding',
  clearInvalidConfig: true,
  defaults: {
    isComplete: false,
    lastAuthProvider: null,
  },
});

const shortcutStore = new Store<{ quickLauncher?: ShortcutConfig }>({
  name: 'shortcuts',
  clearInvalidConfig: true,
  defaults: {},
});

export function configToAccelerator(config: ShortcutConfig): string {
  const modMap: Record<string, string> = {
    Meta: 'CommandOrControl',
    Alt: 'Alt',
    Control: 'Control',
    Shift: 'Shift',
  };
  const mods = config.modifiers.map((modifier) => modMap[modifier] || modifier).join('+');
  return `${mods}+${config.key}`;
}

export function getShortcutConfig(): ShortcutConfig | null {
  return shortcutStore.get('quickLauncher') ?? null;
}

export function setShortcutConfig(config: ShortcutConfig): void {
  shortcutStore.set('quickLauncher', config);
}

export function getOnboardingComplete(): boolean {
  return onboardingStore.get('isComplete', false);
}

export function setOnboardingComplete(complete: boolean): void {
  onboardingStore.set('isComplete', complete);
}

export function getLastAuthProvider(): string | null {
  return onboardingStore.get('lastAuthProvider', null);
}

export function setLastAuthProvider(provider: string): void {
  onboardingStore.set('lastAuthProvider', provider);
}
