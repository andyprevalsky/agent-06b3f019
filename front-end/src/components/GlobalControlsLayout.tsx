/**
 * [APP] -> global rail uses its normal placement.
 * [FULLSCREEN] -> latest mounted header slot owns the same persistent rail host.
 * [CLOSE] -> unregister slot and restore app placement without remounting controls.
 * Bounded DOM ownership only: no subscriptions, user fan-in, or network requests.
 */
import { useCallback, useLayoutEffect, useState, type ReactNode } from 'react';

import {
  GlobalControlsLayoutContext,
  useGlobalControlsLayout,
} from './globalControlsLayoutContext';

export function GlobalControlsLayoutProvider({ children }: { children: ReactNode }) {
  const [slots, setSlots] = useState<HTMLElement[]>([]);
  const register = useCallback((slot: HTMLElement) => {
    setSlots((current) => [...current, slot]);
    return () => setSlots((current) => current.filter((entry) => entry !== slot));
  }, []);
  return (
    <GlobalControlsLayoutContext.Provider value={{ slot: slots.at(-1) ?? null, register }}>
      {children}
    </GlobalControlsLayoutContext.Provider>
  );
}

export function GlobalControlsSlot() {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const { register } = useGlobalControlsLayout();
  useLayoutEffect(() => (element ? register(element) : undefined), [element, register]);
  return (
    <div
      ref={setElement}
      data-testid="fullscreen-global-controls-slot"
      className="flex min-w-0 justify-end"
    />
  );
}
