/**
 * STATE MACHINE: RoseDesktopContext
 *
 *   [NO PROVIDER]            → useRoseDesktop() === false (stock UI everywhere)
 *   [Provider value=false]   → false
 *   [Provider value=true]    → true (Rose Desktop chrome; see lib/roseDesktop.ts)
 *
 * The terminal layout enables it for every visitor with
 * <RoseDesktopContext.Provider value={...}>; shared/benchmark views and tests
 * without a provider get the stock UI.
 */

import { createContext, useContext } from 'react';

export const RoseDesktopContext = createContext(false);

export function useRoseDesktop(): boolean {
  return useContext(RoseDesktopContext);
}
