/** Client-only ownership: app placement <-> mounted fullscreen header slot. */
import { createContext, useContext } from 'react';
interface Layout {
  slot: HTMLElement | null;
  register: (slot: HTMLElement) => () => void;
}
export const GlobalControlsLayoutContext = createContext<Layout>({
  slot: null,
  register: () => () => {},
});
export function useGlobalControlsLayout() {
  return useContext(GlobalControlsLayoutContext);
}
