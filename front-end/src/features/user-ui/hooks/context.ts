/**
 * React context shared by every user-UI mount point.
 *
 * Consumers outside a UserUiProvider (logged-out pages, isolated tests) read
 * the stock-UI default: nothing active, nothing mounted.
 */
import { createContext, useContext } from 'react';

import type { ActiveUserUi } from '../types';
import { InlineLiveCapStore } from './inlineLiveCap';

export interface UserUiContextValue {
  /** Raw active version (kept in safe mode so inline views can show posters). */
  active: ActiveUserUi | null;
  safeMode: boolean;
  setSafeMode: (on: boolean) => void;
  /** Full-viewport shell URL (null in safe mode / when absent). */
  shellUrl: string | null;
  liveCap: InlineLiveCapStore;
}

const defaultLiveCap = new InlineLiveCapStore();

export const STOCK_USER_UI: UserUiContextValue = {
  active: null,
  safeMode: false,
  setSafeMode: () => {},
  shellUrl: null,
  liveCap: defaultLiveCap,
};

export const UserUiContext = createContext<UserUiContextValue>(STOCK_USER_UI);

export function useUserUi(): UserUiContextValue {
  return useContext(UserUiContext);
}
