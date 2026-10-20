/**
 * Shared context object + types for the right app bar and its drawers.
 * Split from the provider so drawer components don't import the provider
 * module (which mounts them).
 */

import { createContext, useContext } from 'react';
import type { Agent } from '../../hooks';

export type RoseApp = 'browser' | 'voice';

export interface AgentBrowserTab {
  agentId: string;
  taskId: string;
  live: boolean;
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
  toggleApp: (app: RoseApp) => void;
  closeApp: () => void;
  openAgentBrowser: (agentId: string, taskId: string) => void;
  selectBrowserTab: (agentId: string | null) => void;
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
