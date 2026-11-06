/**
 * STATE MACHINE: RoseAppsProvider (top-right app icons + the right-panel slot)
 *
 * OPEN APP (one at a time — opening any app or Settings closes the other):
 *   [CLOSED] --click Browser icon | openAgentBrowser(agent, task)--> [BROWSER]
 *   Agent displays are not an app: they render inline in the chat (expandable).
 *   [CLOSED] --Phone icon--> [PHONE]   --Integrations icon--> [INTEGRATIONS]
 *   [CLOSED] --left bar Feedback / Benchmarks / account row--> [FEEDBACK|BENCHMARKS|SETTINGS]
 *   [ANY] --click its trigger again | close button | Escape--> [CLOSED]
 *   [ANY] --another trigger--> that app
 *
 * BROWSER TAB (only meaningful while [BROWSER]):
 *   [ROOT] --click agent tab | openAgentBrowser--> [AGENT(id, taskId)]
 *   [AGENT(id, taskId)] --click Root tab--> [ROOT]
 *   selectedAgentId changes | Browser opens --> [AGENT(selected)] if it has a
 *     browser tab, else [NO_SESSION] (an agent is selected) or [ROOT] (Home).
 *   [NO_SESSION] the selected agent has no browser task: a quiet "No browser
 *     session" state. Never falls back to the user's Root browser (that read as
 *     a random cloud browser); only an explicit Root click shows Root.
 *   Clicking an agent tab also selects that agent, so its chat (and the
 *   BrowserStatusBar that owns its live session state) mounts.
 *
 * BROWSER TASK TABS (registry fed by mounted BrowserStatusBar instances):
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
  onCreateAgentInProject?: (
    project: import('@/lib/api/projects').Project,
    folderId?: string | null,
  ) => void;
  newAgentFolderId?: string | null;
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
      const existing = prev.find((t) => t.agentId === tab.agentId && t.taskId === tab.taskId);
      if (existing === undefined) return [...prev, tab];
      if (
        existing.live === tab.live &&
        (existing.ended ?? false) === (tab.ended ?? false) &&
        existing.taskLabel === tab.taskLabel &&
        (existing.pageUrl ?? null) === (tab.pageUrl ?? null) &&
        (existing.actualModel ?? null) === (tab.actualModel ?? null) &&
        (existing.rosePool ?? null) === (tab.rosePool ?? null) &&
        JSON.stringify(existing.browserSessionMetadata ?? null) ===
          JSON.stringify(tab.browserSessionMetadata ?? null)
      ) {
        return prev;
      }
      return prev.map((t) => (t.agentId === tab.agentId && t.taskId === tab.taskId ? tab : t));
    });
  }, []);

  const unregisterAgentBrowser = useCallback((agentId: string, taskId: string) => {
    if (selectedRef.current !== agentId) return;
    setTabs((prev) => prev.filter((t) => !(t.agentId === agentId && t.taskId === taskId)));
  }, []);

  const focusTask = useCallback((agentId: string, taskId: string) => {
    setTabs((prev) => {
      if (prev.some((t) => t.agentId === agentId && t.taskId === taskId)) return prev;
      return [...prev, { agentId, taskId, live: true }];
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

/** Coordinate app drawers and deferred browser-tab selection for the selected agent. */
export function RoseAppsProvider({
  children,
  agents = [],
  selectedAgentId = null,
  onSelectAgent,
  publishLayout = false,
  onLogout,
  onCreateAgentInProject,
  newAgentFolderId,
}: ProviderProps) {
  const localLink =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('browser') === 'local';
  const [browserMode, setBrowserMode] = useState<'local' | 'remote'>(
    localLink ? 'local' : 'remote',
  );
  const [openApp, setOpenApp] = useState<RoseApp | null>(
    publishLayout && localLink ? 'browser' : null,
  );
  const [browserSelection, setBrowserSelection] = useState<{
    agentId: string;
    taskId: string;
  } | null>(null);
  /** Root was clicked explicitly; otherwise a selected agent without a tab shows NO_SESSION. */
  const [browserRootChosen, setBrowserRootChosen] = useState(false);
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

  // Derive removal fallback without an effect that could race initial registration.
  const selectedBrowserTab =
    browserSelection === null
      ? undefined
      : (tabs.find(
          (tab) =>
            tab.agentId === browserSelection.agentId && tab.taskId === browserSelection.taskId,
        ) ?? tabs.find((tab) => tab.agentId === browserSelection.agentId));
  const browserTabAgentId = selectedBrowserTab?.agentId ?? null;
  const browserTabTaskId = selectedBrowserTab?.taskId ?? null;

  // Selecting an agent in the agent list switches to its tab. Its status bar
  // may register after the selection, so a pending switch completes on register.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const pendingSwitchRef = useRef<string | null>(selectedAgentId);
  const isFirstSelectionRef = useRef(true);
  useEffect(() => {
    if (isFirstSelectionRef.current) {
      isFirstSelectionRef.current = false;
      return;
    }
    const tab = tabsRef.current.find((t) => t.agentId === selectedAgentId);
    pendingSwitchRef.current = tab ? null : selectedAgentId;
    setBrowserRootChosen(false);
    setBrowserSelection((current) => {
      if (
        current?.agentId === selectedAgentId &&
        tabsRef.current.some((t) => t.agentId === current.agentId && t.taskId === current.taskId)
      )
        return current;
      return tab ? { agentId: tab.agentId, taskId: tab.taskId } : null;
    });
  }, [selectedAgentId]);
  const registerAndSwitch = useCallback(
    (tab: AgentBrowserTab) => {
      registerAgentBrowser(tab);
      if (pendingSwitchRef.current === tab.agentId) {
        pendingSwitchRef.current = null;
        setBrowserSelection({ agentId: tab.agentId, taskId: tab.taskId });
      }
    },
    [registerAgentBrowser],
  );

  const toggleApp = useCallback(
    (app: RoseApp) => {
      // Opening Browser lands on the selected agent's tab when it has one.
      if (app === 'browser' && openApp !== 'browser') {
        setBrowserRootChosen(false);
        const tab = tabsRef.current.find((t) => t.agentId === selectedAgentId);
        pendingSwitchRef.current = tab ? null : selectedAgentId;
        setBrowserSelection((current) => {
          if (
            current &&
            tabsRef.current.some(
              (t) => t.agentId === current.agentId && t.taskId === current.taskId,
            )
          )
            return current;
          return tab ? { agentId: tab.agentId, taskId: tab.taskId } : null;
        });
      }
      setOpenApp((prev) => (prev === app ? null : app));
    },
    [openApp, selectedAgentId],
  );
  const closeApp = useCallback(() => setOpenApp(null), []);

  const openAgentBrowser = useCallback(
    (agentId: string, taskId: string) => {
      setBrowserMode('remote');
      focusTask(agentId, taskId);
      setBrowserRootChosen(false);
      setBrowserSelection({ agentId, taskId });
      setOpenApp('browser');
    },
    [focusTask],
  );

  const selectBrowserTab = useCallback(
    (agentId: string | null, taskId?: string) => {
      const tab = tabsRef.current.find(
        (t) => t.agentId === agentId && (taskId === undefined || t.taskId === taskId),
      );
      setBrowserSelection(tab ? { agentId: tab.agentId, taskId: tab.taskId } : null);
      pendingSwitchRef.current = null;
      setBrowserRootChosen(agentId === null);
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
      browserTabTaskId === taskId &&
      tabs.some((t) => t.agentId === agentId && t.taskId === taskId),
    [browserTabAgentId, browserTabTaskId, browserMode, openApp, tabs],
  );

  const value = useMemo<RoseAppsValue>(
    () => ({
      openApp,
      browserMode,
      setBrowserMode,
      browserTabAgentId,
      browserRootChosen,
      browserTabTaskId,
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
      newAgentFolderId,
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
      browserTabAgentId,
      browserRootChosen,
      browserTabTaskId,
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
      newAgentFolderId,
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
