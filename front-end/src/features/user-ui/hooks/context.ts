/**
 * React context shared by every user-UI mount point.
 *
 * Consumers outside a UserUiProvider (logged-out pages, isolated tests) read
 * the stock-UI default: nothing active, nothing opaque, nothing mounted.
 */
import { createContext, useContext } from 'react';

import type { ActiveUserUi, ResolvedBackground, UserUiSlotName } from '../types';
import { InlineLiveCapStore } from './inlineLiveCap';

export interface UserUiContextValue {
  /** Raw active version (kept in safe mode so inline views can show posters). */
  active: ActiveUserUi | null;
  safeMode: boolean;
  setSafeMode: (on: boolean) => void;
  /** Background image in effect (null in safe mode or when none is published). */
  background: ResolvedBackground | null;
  /** Usercontent URL of a mounted slot (null in safe mode / when absent). */
  slotUrl: (name: UserUiSlotName) => string | null;
  /** Full-viewport shell URL (null in safe mode / when absent). */
  shellUrl: string | null;
  liveCap: InlineLiveCapStore;
}

const defaultLiveCap = new InlineLiveCapStore();

export const STOCK_USER_UI: UserUiContextValue = {
  active: null,
  safeMode: false,
  setSafeMode: () => {},
  background: null,
  slotUrl: () => null,
  shellUrl: null,
  liveCap: defaultLiveCap,
};

export const UserUiContext = createContext<UserUiContextValue>(STOCK_USER_UI);

export function useUserUi(): UserUiContextValue {
  return useContext(UserUiContext);
}

/**
 * While a background image shows through, chrome that is normally translucent
 * (sidebar, query box) must render opaque so it stays legible.
 */
export function useUserUiOpaqueSurfaces(): boolean {
  return useContext(UserUiContext).background !== null;
}

/** True when the published shell replaces the stock app chrome. */
export function useUserUiShellActive(): boolean {
  return useContext(UserUiContext).shellUrl !== null;
}
