/**
 * STATE MACHINE: BrowserAppDrawer
 *
 *   [CLOSED] <--> [OPEN]  (owned by RoseAppsProvider.openApp === 'browser')
 *
 *   TABS (while OPEN):
 *   [ROOT]  "Your browser" placeholder (the per-user root browser is future work)
 *   [AGENT(id)] body = drawer slot; the agent's focused BrowserStatusBar portals
 *               its live view (letterboxed 1280x800, task progress, take
 *               over / hand back, waiting + disconnected overlays) into it.
 *               Until it mounts (agent just selected) a connecting state shows.
 *   click tab --> selectBrowserTab(agentId | null) (agent tabs also select the agent)
 *
 *   BROWSER CHROME (UI ledger row 74), below the tabs:
 *   [Back] [Forward] [Reload] ( address bar ) [LIVE]
 *     Back / Forward: dimmed + disabled — the agent's remote browser exposes
 *       no history navigation to the app yet (Root is a placeholder).
 *     Reload: agent tab --> reloadBrowser() (the live view remounts);
 *       dimmed on Root.
 *     Address bar: the agent tab's page URL (host bold, rest muted) from its
 *       latest browser step; "Connecting…" until one is known; empty on Root.
 *     LIVE: while the shown agent session is live.
 *
 *   Header: globe + "Browser". No close X on desktop: the top-right Browser
 *   icon (floating over this corner) and Escape close it (UI ledger row 67).
 */

import { ArrowLeft, ArrowRight, Globe, RotateCw, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Agent } from '../../hooks';
import { AppDrawerShell } from './AppDrawerShell';
import { addressParts } from './browserPageUrl';
import { useRoseApps, type AgentBrowserTab } from './roseAppsState';

function agentTitle(agents: Agent[], agentId: string): string {
  const agent = agents.find((a) => a.agent_id === agentId);
  const title = agent?.title ?? agent?.goal ?? '';
  return title.trim() === '' ? 'Agent' : title;
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
        '-mb-px flex max-w-[220px] flex-none items-center gap-[7px] whitespace-nowrap border-b-2 pb-2.5 pt-[9px] text-[13px]',
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

function LiveBadge() {
  return (
    <span
      data-testid="browser-drawer-live"
      className="flex flex-none items-center gap-[5px] text-[11px] font-bold tracking-[.06em] text-[#e5484d]"
    >
      <i aria-hidden="true" className="block h-1.5 w-1.5 animate-pulse rounded-full bg-[#e5484d]" />
      LIVE
    </span>
  );
}

function RootBrowserEmptyState() {
  return (
    <div
      data-testid="root-browser-empty"
      className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center"
    >
      <Globe className="h-8 w-8 text-[hsl(240_8%_45%)] dark:text-[#a3a39d]" strokeWidth={1.5} />
      <div className="text-sm font-semibold">Your browser</div>
      <p className="max-w-xs text-xs text-[hsl(240_8%_45%)] dark:text-[#a3a39d]">
        Sign in to sites here and every agent can use those logins. Coming soon.
      </p>
    </div>
  );
}

export function BrowserAppDrawer() {
  const apps = useRoseApps();
  if (apps === null) return null;
  const open = apps.openApp === 'browser';
  const activeAgentId = apps.browserTabAgentId;
  const activeTab = apps.tabs.find((t) => t.agentId === activeAgentId) ?? null;
  const isRoot = activeAgentId === null;
  const waitingForPane =
    activeAgentId !== null &&
    apps.selectedAgentId !== null &&
    activeAgentId !== apps.selectedAgentId;
  return (
    <AppDrawerShell open={open} label="Browser drawer" testId="browser-app-drawer" variant="full">
      <div className="flex flex-none items-center gap-2.5 px-[18px] pb-3 pt-4 text-[15px] font-semibold">
        <Globe className="h-[18px] w-[18px] flex-none" strokeWidth={1.7} />
        Browser
      </div>
      <div
        role="tablist"
        aria-label="Browser tabs"
        className="flex flex-none gap-5 overflow-x-auto border-b border-gray-200/90 px-[18px] dark:border-white/[0.09]"
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
            selected={activeAgentId === tab.agentId}
            onClick={() => apps.selectBrowserTab(tab.agentId)}
          >
            <AgentTabLabel tab={tab} title={agentTitle(apps.agents, tab.agentId)} />
          </DrawerTab>
        ))}
      </div>
      <div
        data-testid="browser-chrome"
        className="flex flex-none items-center gap-2 px-[18px] pb-1 pt-3.5"
      >
        <span className="inline-flex flex-none gap-0.5">
          <NavButton icon={ArrowLeft} label="Back" />
          <NavButton icon={ArrowRight} label="Forward" />
          <NavButton
            icon={RotateCw}
            label="Reload"
            onClick={isRoot ? undefined : apps.reloadBrowser}
          />
        </span>
        <AddressBar url={activeTab?.pageUrl ?? null} isRoot={isRoot} />
        {activeTab?.live === true && <LiveBadge />}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {isRoot && <RootBrowserEmptyState />}
        {waitingForPane && (
          <div className="flex flex-1 items-center justify-center text-xs text-[hsl(240_8%_45%)] dark:text-[#a3a39d]">
            Opening agent…
          </div>
        )}
        <div
          ref={apps.setSlot}
          data-testid="browser-drawer-slot"
          className={cn('min-h-0 flex-1 flex-col', isRoot ? 'hidden' : 'flex')}
        />
      </div>
    </AppDrawerShell>
  );
}
