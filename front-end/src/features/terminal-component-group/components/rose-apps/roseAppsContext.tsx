/**
 * STATE MACHINE: RoseAppsProvider (top-right app icons + the right-panel slot)
 *
 * OPEN APP (one at a time — opening any app or Settings closes the other):
 *   [CLOSED] --click Browser icon | openAgentBrowser(agent, task)--> [BROWSER]
 *   [CLOSED] --Phone icon--> [PHONE]   --Integrations icon--> [INTEGRATIONS]
 *   [CLOSED] --left bar Feedback / Benchmarks / account row--> [FEEDBACK|BENCHMARKS|SETTINGS]
 *   [ANY] --click its trigger again | close button | Escape--> [CLOSED]
 *   [ANY] --another trigger--> that app
 *
 * BROWSER TAB (only meaningful while [BROWSER]):
 *   [ROOT] --click agent tab | openAgentBrowser--> [AGENT(id)]
 *   [AGENT(id)] --click Root tab--> [ROOT]
 *   selectedAgentId changes --> [AGENT(selected)] if it has a browser tab, else [ROOT]
 *   Clicking an agent tab also selects that agent, so its chat (and the
 *   BrowserStatusBar that owns its live session state) mounts.
 *
 * AGENT TABS (registry fed by mounted BrowserStatusBar instances):
 *   register(agentId, taskId, live) --> tab exists / updated
 *   unregister while that agent is still selected (browser task ended) --> tab removed
 *   unregister after switching agents --> tab kept (session still running)
 *   agent leaves the active set (completed/failed/archived) --> tab removed
 *
 * RELOAD: the drawer's Reload button bumps browserReloadKey; the focused
 * BrowserStatusBar keys its portaled live view on it, so the viewer remounts.
 *
 * The drawer body for an agent tab is a DOM slot. The focused task's
 * BrowserStatusBar portals its live view into it, so take/hand-back control,
 * session binding and progress state stay owned by that status bar (React
 * context flows through the portal).
 *
 * LAYOUT: with `publishLayout` (the real terminal layout, Rose Desktop only)
 * publishes on <html>: --rose-apps-nav-visibility: hidden (the website's
 * Research/Careers/Download links give way to the app icons) and
 * --rose-app-icons-inset (px the top-right icon row occupies, so the account
 * rail sits left of it). Panels overlay the content: there is no right bar and
 * no content inset (UI ledger row 66). Panels portal to <body>; they mount on
 * first open (lazy) and stay mounted afterwards so they can slide out.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { Agent } from '../../hooks';
import { appIconsInset, clampDrawerWidth, defaultDrawerWidth } from './roseAppsLayout';
import { ROSE_APP_ICON_COUNT } from './roseAppCatalog';
import { RoseAppDrawers } from './RoseAppDrawers';
import { useAgentDisplays } from './useAgentDisplays';
import {
  RoseAppsContext,
  type AgentBrowserTab,
  type RoseApp,
  type RoseAppsValue,
} from './roseAppsState';

const ACTIVE_AGENT_STATUSES = new Set<Agent['status']>(['STARTING_UP', 'ACTIVE', 'PAUSED']);

interface ProviderProps {
  children: ReactNode;
  agents?: Agent[];
  selectedAgentId?: string | null;
  onSelectAgent?: (agentId: string) => void;
  /** Publish the layout CSS variables on <html> (only the app's terminal layout does). */
  publishLayout?: boolean;
  /** Sign out, offered at the bottom of the Settings panel. */
  onLogout?: () => void;
  onCreateAgentInProject?: (project: import('@/lib/api/projects').Project) => void;
}

/** Publish the Rose Desktop layout variables on <html> while mounted. */
function usePublishedLayout(enabled: boolean) {
  useLayoutEffect(() => {
    if (!enabled) return undefined;
    const root = document.documentElement.style;
    root.setProperty('--rose-apps-nav-visibility', 'hidden');
    root.setProperty('--rose-app-icons-inset', `${appIconsInset(ROSE_APP_ICON_COUNT)}px`);
    return () => {
      root.removeProperty('--rose-apps-nav-visibility');
      root.removeProperty('--rose-app-icons-inset');
    };
  }, [enabled]);
}

function useAgentTabs(agents: Agent[], selectedAgentId: string | null) {
  const [tabs, setTabs] = useState<AgentBrowserTab[]>([]);
  const selectedRef = useRef(selectedAgentId);
  selectedRef.current = selectedAgentId;

  const registerAgentBrowser = useCallback((tab: AgentBrowserTab) => {
    setTabs((prev) => {
      const existing = prev.find((t) => t.agentId === tab.agentId);
      if (existing === undefined) return [...prev, tab];
      // Another browser of the same agent owns the tab; keep the focused task.
      if (existing.taskId !== tab.taskId) return prev;
      if (
        existing.live === tab.live &&
        (existing.pageUrl ?? null) === (tab.pageUrl ?? null) &&
        JSON.stringify(existing.browserSessionMetadata ?? null) ===
          JSON.stringify(tab.browserSessionMetadata ?? null)
      ) {
        return prev;
      }
      return prev.map((t) => (t.agentId === tab.agentId ? tab : t));
    });
  }, []);

  const unregisterAgentBrowser = useCallback((agentId: string, taskId: string) => {
    if (selectedRef.current !== agentId) return;
    setTabs((prev) => prev.filter((t) => !(t.agentId === agentId && t.taskId === taskId)));
  }, []);

  const focusTask = useCallback((agentId: string, taskId: string) => {
    setTabs((prev) => {
      const existing = prev.find((t) => t.agentId === agentId);
      if (existing === undefined) return [...prev, { agentId, taskId, live: true }];
      if (existing.taskId === taskId) return prev;
      return prev.map((t) => (t.agentId === agentId ? { agentId, taskId, live: true } : t));
    });
  }, []);

  // Drop tabs whose agent is no longer running (only when the list knows it).
  const visibleTabs = useMemo(() => {
    if (agents.length === 0) return tabs;
    return tabs.filter((t) => {
      const agent = agents.find((a) => a.agent_id === t.agentId);
      return agent === undefined || ACTIVE_AGENT_STATUSES.has(agent.status);
    });
  }, [agents, tabs]);

  return { tabs: visibleTabs, registerAgentBrowser, unregisterAgentBrowser, focusTask };
}

function useDrawerWidthState() {
  const [width, setWidth] = useState<number | null>(null);
  const [viewport, setViewport] = useState(() =>
    typeof window === 'undefined' ? 1440 : window.innerWidth,
  );
  useEffect(() => {
    const onResize = () => setViewport(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const drawerWidth = clampDrawerWidth(width ?? defaultDrawerWidth(viewport), viewport);
  const setDrawerWidth = useCallback((next: number) => setWidth(next), []);
  return { drawerWidth, setDrawerWidth };
}

export function RoseAppsProvider({
  children,
  agents = [],
  selectedAgentId = null,
  onSelectAgent,
  publishLayout = false,
  onLogout,
  onCreateAgentInProject,
}: ProviderProps) {
  const displays = useAgentDisplays();
  const { selectDisplay } = displays;
  const localLink =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('browser') === 'local';
  const [browserMode, setBrowserMode] = useState<'local' | 'remote'>(
    localLink ? 'local' : 'remote',
  );
  const [openApp, setOpenApp] = useState<RoseApp | null>(
    publishLayout && localLink ? 'browser' : null,
  );
  const [browserTabAgentId, setBrowserTabAgentId] = useState<string | null>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [browserComposerSlot, setBrowserComposerSlot] = useState<HTMLElement | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [browserReloadKey, setBrowserReloadKey] = useState(0);
  const reloadBrowser = useCallback(() => setBrowserReloadKey((k) => k + 1), []);
  const { drawerWidth, setDrawerWidth } = useDrawerWidthState();
  const { tabs, registerAgentBrowser, unregisterAgentBrowser, focusTask } = useAgentTabs(
    agents,
    selectedAgentId,
  );

  // Selecting an agent in the agent list switches to its tab. Its status bar
  // may register after the selection, so a pending switch completes on register.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const pendingSwitchRef = useRef<string | null>(null);
  const isFirstSelectionRef = useRef(true);
  useEffect(() => {
    if (isFirstSelectionRef.current) {
      isFirstSelectionRef.current = false;
      return;
    }
    const hasTab = tabsRef.current.some((t) => t.agentId === selectedAgentId);
    pendingSwitchRef.current = hasTab ? null : selectedAgentId;
    setBrowserTabAgentId(hasTab ? selectedAgentId : null);
  }, [selectedAgentId]);
  const registerAndSwitch = useCallback(
    (tab: AgentBrowserTab) => {
      registerAgentBrowser(tab);
      if (pendingSwitchRef.current === tab.agentId) {
        pendingSwitchRef.current = null;
        setBrowserTabAgentId(tab.agentId);
      }
    },
    [registerAgentBrowser],
  );

  const toggleApp = useCallback(
    (app: RoseApp) => {
      // Opening Browser lands on the selected agent's tab when it has one.
      if (app === 'browser' && openApp !== 'browser') {
        const hasTab = tabsRef.current.some((t) => t.agentId === selectedAgentId);
        if (hasTab) setBrowserTabAgentId(selectedAgentId);
      }
      setOpenApp((prev) => (prev === app ? null : app));
    },
    [openApp, selectedAgentId],
  );
  const openAgentDisplay = useCallback(
    (agentId: string, id: string) => {
      selectDisplay({ agentId, id });
      if (agentId !== selectedAgentId) onSelectAgent?.(agentId);
      setOpenApp('display');
    },
    [selectDisplay, onSelectAgent, selectedAgentId],
  );
  const closeApp = useCallback(() => setOpenApp(null), []);

  const openAgentBrowser = useCallback(
    (agentId: string, taskId: string) => {
      setBrowserMode('remote');
      focusTask(agentId, taskId);
      setBrowserTabAgentId(agentId);
      setOpenApp('browser');
    },
    [focusTask],
  );

  const selectBrowserTab = useCallback(
    (agentId: string | null) => {
      setBrowserTabAgentId(agentId);
      if (agentId !== null && agentId !== selectedAgentId) onSelectAgent?.(agentId);
    },
    [onSelectAgent, selectedAgentId],
  );

  const openAgent = useCallback((agentId: string) => onSelectAgent?.(agentId), [onSelectAgent]);

  useEffect(() => {
    if (openApp === null) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenApp(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openApp]);

  const isTaskInDrawer = useCallback(
    (agentId: string | null, taskId: string) =>
      openApp === 'browser' &&
      browserMode === 'remote' &&
      agentId !== null &&
      browserTabAgentId === agentId &&
      tabs.some((t) => t.agentId === agentId && t.taskId === taskId),
    [browserTabAgentId, browserMode, openApp, tabs],
  );

  const value = useMemo<RoseAppsValue>(
    () => ({
      openApp,
      browserMode,
      setBrowserMode,
      ...displays,
      openAgentDisplay,
      browserTabAgentId,
      tabs,
      agents,
      selectedAgentId,
      drawerWidth,
      isResizing,
      slot,
      browserComposerSlot,
      setBrowserComposerSlot,
      browserReloadKey,
      reloadBrowser,
      toggleApp,
      closeApp,
      openAgentBrowser,
      selectBrowserTab,
      openAgent,
      onLogout,
      onCreateAgentInProject,
      setSlot,
      setDrawerWidth,
      setIsResizing,
      registerAgentBrowser: registerAndSwitch,
      unregisterAgentBrowser,
      isTaskInDrawer,
    }),
    [
      openApp,
      browserMode,
      displays,
      openAgentDisplay,
      browserTabAgentId,
      tabs,
      agents,
      selectedAgentId,
      drawerWidth,
      isResizing,
      slot,
      browserComposerSlot,
      setBrowserComposerSlot,
      browserReloadKey,
      reloadBrowser,
      toggleApp,
      closeApp,
      openAgentBrowser,
      selectBrowserTab,
      openAgent,
      onLogout,
      onCreateAgentInProject,
      setDrawerWidth,
      registerAndSwitch,
      unregisterAgentBrowser,
      isTaskInDrawer,
    ],
  );

  usePublishedLayout(publishLayout);

  return (
    <RoseAppsContext.Provider value={value}>
      {children}
      {typeof document !== 'undefined' && createPortal(<RoseAppDrawers />, document.body)}
    </RoseAppsContext.Provider>
  );
}
