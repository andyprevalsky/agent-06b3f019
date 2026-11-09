/**
 * STATE MACHINE: PhoneLauncherContext
 *
 *   [NO PROVIDER] --> usePhoneLauncher() === null (no Phone app to open; callers
 *                     fall back to links)
 *   [RoseAppsProvider] --> { openPhoneDevice } opens the Phone app in DEVICE VIEW
 *                     (live screen of the account's iPhone, no agent/task, no lease)
 *
 * Shared so features (Integrations) can open the Phone app without importing
 * the terminal-component-group feature.
 */
import { createContext, useContext } from 'react';

export interface PhoneLauncher {
  /** Open the floating Phone app showing the device itself, whoever is using it. */
  openPhoneDevice: () => void;
}

export const PhoneLauncherContext = createContext<PhoneLauncher | null>(null);

export function usePhoneLauncher(): PhoneLauncher | null {
  return useContext(PhoneLauncherContext);
}
