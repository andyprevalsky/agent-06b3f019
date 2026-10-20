/**
 * Shared context object + types for the Rose Desktop app icons and panels.
 * Split from the provider so panel components don't import the provider
 * module (which mounts them).
 */

import { createContext, useContext } from 'react';
import type { Agent } from '../../hooks';

/**
 * Everything that opens in the right-panel slot (one at a time):
 *   browser       full screen between the left bar and the right edge
 *   phone         floating device, no panel
 *   integrations | benchmarks | feedback | health | settings   flush right panels
 */
export type RoseApp =
  | 'browser'
  | 'phone'
  | 'integrations'
  | 'benchmarks'
  | 'feedback'
  | 'health'
  | 'settings';

export interface AgentBrowserTab {
  agentId: string;
  taskId: string;
  live: boolean;
  /** Page the agent's browser is on (address bar, UI ledger row 74); null = unknown yet. */
  pageUrl?: string | null;
}

export interface RoseAppsValue {
  openApp: RoseApp | null;
  /** null = Root tab. */
  browserTabAgentId: string | null;
  tabs: AgentBrowserTab[];
  agents: Agent[];
  selectedAgentId: string | null;
  drawerWidth: number;
  isResizing: boolean;
  slot: HTMLElement | null;
  /** Bumped by the Browser drawer's Reload button; the live view remounts on change. */
  browserReloadKey: number;
  reloadBrowser: () => void;
  toggleApp: (app: RoseApp) => void;
  closeApp: () => void;
  openAgentBrowser: (agentId: string, taskId: string) => void;
  selectBrowserTab: (agentId: string | null) => void;
  /** Open an agent in the main chat (Benchmarks panel rows). */
  openAgent: (agentId: string) => void;
  /** Sign out (Settings panel); undefined when the host has no session. */
  onLogout?: () => void;
  setSlot: (el: HTMLElement | null) => void;
  setDrawerWidth: (width: number) => void;
  setIsResizing: (resizing: boolean) => void;
  registerAgentBrowser: (tab: AgentBrowserTab) => void;
  unregisterAgentBrowser: (agentId: string, taskId: string) => void;
  /** True when this task's live view should render inside the browser drawer. */
  isTaskInDrawer: (agentId: string | null, taskId: string) => boolean;
}

export const RoseAppsContext = createContext<RoseAppsValue | null>(null);

export function useRoseApps(): RoseAppsValue | null {
  return useContext(RoseAppsContext);
}
