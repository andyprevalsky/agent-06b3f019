/** Browser drawer: one mode/tab/proxy row, navigation, then side-by-side trajectory and browser. */
import { useEffect, useRef } from 'react';
import { ArrowLeft, ArrowRight, RotateCw, type LucideIcon } from 'lucide-react';
import { useRoseDesktop } from '@/hooks/roseDesktopContext';
import { cn } from '@/lib/utils';
import type { Agent } from '../../hooks';
import { AppDrawerShell } from './AppDrawerShell';
import { BrowserModeTabs } from './BrowserModeTabs';
import { LocalPreviewPane } from './LocalPreviewPane';
import { BrowserProxyLocationChip } from '../browser-status-bar/BrowserProxyLocationChip';
import { addressParts } from './browserPageUrl';
import { RootBrowserPane } from './RootBrowserPane';
import { useRoseApps, type AgentBrowserTab, type RoseAppsValue } from './roseAppsState';
import { useRootBrowserActions, useRootBrowserState } from './useBrowserWorld';

const MUTED = 'text-[hsl(240_8%_45%)] dark:text-[#a3a39d]';

function knownAgentTitle(agents: Agent[], agentId: string): string | null {
  const agent = agents.find((a) => a.agent_id === agentId);
  const title = (agent?.title ?? agent?.goal ?? '').trim();
  return title === '' ? null : title;
}

function agentTitle(agents: Agent[], agentId: string): string {
  return knownAgentTitle(agents, agentId) ?? 'Agent';
}

function DrawerTab({
  selected,
  onClick,
  children,
  testId,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      data-testid={testId}
      onClick={onClick}
      className={cn(
        'flex h-full max-w-[220px] flex-none items-center gap-[7px] whitespace-nowrap border-b-2 text-[13px]',
        selected
          ? 'border-[#272725] font-semibold text-[hsl(240_15%_8%)] dark:border-[#ecece8] dark:text-[#ecece8]'
          : 'border-transparent text-[hsl(240_8%_45%)] hover:text-[hsl(240_15%_8%)] dark:text-[#a3a39d] dark:hover:text-[#ecece8]',
      )}
    >
      {children}
    </button>
  );
}

function AgentTabLabel({ tab, title }: { tab: AgentBrowserTab; title: string }) {
  return (
    <>
      <i
        aria-hidden="true"
        className={cn(
          'block h-[7px] w-[7px] flex-none rounded-full',
          tab.live ? 'bg-green-500' : 'bg-gray-300 dark:bg-white/[0.25]',
        )}
      />
      <span className="truncate">{title}</span>
    </>
  );
}

function NavButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
}) {
  const enabled = onClick !== undefined;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={!enabled}
      onClick={onClick}
      className={cn(
        'grid h-7 w-7 place-items-center rounded-[7px]',
        enabled
          ? 'text-[hsl(240_8%_30%)] hover:bg-[hsl(240_5%_95%)] dark:text-[#ecece8] dark:hover:bg-white/[0.06]'
          : 'cursor-default text-[hsl(240_6%_72%)] dark:text-white/[0.25]',
      )}
    >
      <Icon className="h-4 w-4" strokeWidth={2} />
    </button>
  );
}

function AddressBar({ url, isRoot }: { url: string | null; isRoot: boolean }) {
  const parts = url === null ? null : addressParts(url);
  return (
    <div
      data-testid="browser-address-bar"
      title={url ?? undefined}
      className="min-w-0 flex-1 truncate whitespace-nowrap rounded-full bg-[hsl(240_5%_96%)] px-3 py-1.5 text-[12.5px] text-[hsl(240_8%_45%)] dark:bg-[#2f2f2c] dark:text-[#a3a39d]"
    >
      {parts !== null ? (
        <>
          <b className="font-medium text-[hsl(240_15%_8%)] dark:text-[#ecece8]">{parts.host}</b>
          {parts.rest}
        </>
      ) : isRoot ? (
        <span>Your browser</span>
      ) : (
        <span>Connecting…</span>
      )}
    </div>
  );
}

function BrowserTabs({ apps, isRoot }: { apps: RoseAppsValue; isRoot: boolean }) {
  return (
    <div
      role="tablist"
      aria-label="Browser tabs"
      className="flex h-full min-h-0 min-w-0 flex-1 items-center gap-5 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <DrawerTab
        testId="browser-tab-root"
        selected={isRoot}
        onClick={() => apps.selectBrowserTab(null)}
      >
        Root
      </DrawerTab>
      {apps.tabs.map((tab) => (
        <DrawerTab
          key={tab.agentId}
          testId={`browser-tab-${tab.agentId}`}
          selected={apps.browserTabAgentId === tab.agentId}
          onClick={() => apps.selectBrowserTab(tab.agentId)}
        >
          <AgentTabLabel tab={tab} title={agentTitle(apps.agents, tab.agentId)} />
        </DrawerTab>
      ))}
    </div>
  );
}

/**
 * Mounted only while the drawer is open on Root: closing it drops the live view.
 * With an agent selected, a closed Root opens once at that tree's default_url;
 * with none (or no default_url yet) it stays on the quiet "Open browser".
 */
function RootTab({ reloadKey, agentId }: { reloadKey: number; agentId: string | null }) {
  const state = useRootBrowserState(true, agentId);
  const actions = useRootBrowserActions();
  const defaultUrl = agentId === null ? null : (state.data?.default_url ?? null);
  const startedRef = useRef(false);
  const { mutate: openRoot } = actions.open;
  const rootClosed = state.data !== undefined && state.data.root === null;
  useEffect(() => {
    if (startedRef.current || !rootClosed || defaultUrl === null) return;
    startedRef.current = true;
    openRoot(defaultUrl);
  }, [rootClosed, defaultUrl, openRoot]);
  let error: string | null = null;
  // The user's latest action speaks first: a failed open outranks the read.
  if (actions.open.isError) error = 'Couldn’t open your browser. Try again.';
  else if (state.isError) error = 'Couldn’t reach your browser.';
  return (
    <RootBrowserPane
      loading={state.isPending}
      root={state.data?.root ?? null}
      error={error}
      receipt={actions.receipt}
      opening={actions.open.isPending}
      closing={actions.close.isPending}
      reloadKey={reloadKey}
      onOpen={() => actions.open.mutate(defaultUrl ?? undefined)}
      onClose={() => actions.close.mutate()}
    />
  );
}

function BrowserChrome({
  apps,
  activeTab,
  isRoot,
}: {
  apps: RoseAppsValue;
  activeTab: AgentBrowserTab | null;
  isRoot: boolean;
}) {
  // Reads the cached Root state only (enabled false): never fetches by itself.
  const rootOpen = (useRootBrowserState(false, apps.selectedAgentId).data?.root ?? null) !== null;
  const canReload = !isRoot || rootOpen;
  return (
    <div data-testid="browser-chrome" className="flex flex-none items-center gap-2 px-[18px] py-2">
      <span className="inline-flex flex-none gap-0.5">
        <NavButton icon={ArrowLeft} label="Back" />
        <NavButton icon={ArrowRight} label="Forward" />
        <NavButton
          icon={RotateCw}
          label="Reload"
          onClick={canReload ? apps.reloadBrowser : undefined}
        />
      </span>
      <AddressBar url={activeTab?.pageUrl ?? null} isRoot={isRoot} />
    </div>
  );
}

export function BrowserAppDrawer() {
  const apps = useRoseApps();
  const roseDesktop = useRoseDesktop();
  if (apps === null) return null;
  const open = apps.openApp === 'browser';
  const active = open && roseDesktop;
  const activeAgentId = apps.browserTabAgentId;
  const activeTab = apps.tabs.find((t) => t.agentId === activeAgentId) ?? null;
  const isRoot = activeAgentId === null;
  const waitingForPane =
    activeAgentId !== null &&
    apps.selectedAgentId !== null &&
    activeAgentId !== apps.selectedAgentId;
  return (
    <AppDrawerShell
      open={open}
      label="Browser drawer"
      testId="browser-app-drawer"
      variant="full"
      aboveQuerybox
    >
      <div
        data-testid="browser-drawer-header"
        className="flex h-[56px] flex-none items-center px-[18px] pr-12 md:pr-56 text-sm font-semibold"
      >
        Browser
      </div>
      <div
        data-testid="browser-tabs-row"
        className="flex h-10 min-w-0 flex-none items-center gap-5 border-b border-border px-[18px]"
      >
        {apps.browserMode === 'remote' ? (
          <BrowserTabs apps={apps} isRoot={isRoot} />
        ) : (
          <div className="flex-1" />
        )}
        <div className="flex flex-none items-center gap-1">
          <BrowserModeTabs />
          <BrowserProxyLocationChip
            metadata={activeTab?.browserSessionMetadata ?? null}
            routing={apps.browserMode}
            bare
          />
        </div>
      </div>
      {apps.browserMode === 'local' ? (
        active && <LocalPreviewPane key={apps.selectedAgentId} agentId={apps.selectedAgentId} />
      ) : (
        <>
          <BrowserChrome apps={apps} activeTab={activeTab} isRoot={isRoot} />
          <div className="flex min-h-0 flex-1 flex-col">
            {isRoot && active && (
              <RootTab reloadKey={apps.browserReloadKey} agentId={apps.selectedAgentId} />
            )}
            {waitingForPane && (
              <div className={`flex flex-1 items-center justify-center text-xs ${MUTED}`}>
                Opening agent…
              </div>
            )}
            <div
              ref={apps.setSlot}
              data-testid="browser-drawer-slot"
              className={cn('min-h-0 flex-1 flex-col', isRoot ? 'hidden' : 'flex')}
            />
          </div>
        </>
      )}
    </AppDrawerShell>
  );
}
