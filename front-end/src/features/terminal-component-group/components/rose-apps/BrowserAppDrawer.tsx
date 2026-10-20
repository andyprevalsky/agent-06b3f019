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
 *   Header: globe + "Browser" + LIVE badge while the shown agent session is live.
 *   No close X: the top-right Browser icon (floating over this corner) and
 *   Escape close it (UI ledger row 67).
 */

import { Globe } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Agent } from '../../hooks';
import { AppDrawerShell } from './AppDrawerShell';
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
        'flex max-w-[220px] items-center gap-1.5 rounded-t-lg border border-b-0 border-gray-200/90 px-3 py-1.5 text-xs',
        selected
          ? 'bg-white font-semibold text-[hsl(240_15%_8%)] shadow-[inset_0_-2px_0_#f7799f]'
          : 'bg-[hsl(240_10%_97%)] text-[hsl(240_8%_40%)]',
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
          tab.live ? 'bg-green-500' : 'bg-gray-300',
        )}
      />
      <span className="truncate">{title}</span>
    </>
  );
}

function RootBrowserEmptyState() {
  return (
    <div
      data-testid="root-browser-empty"
      className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center"
    >
      <Globe className="h-8 w-8 text-[hsl(240_8%_45%)]" strokeWidth={1.5} />
      <div className="text-sm font-semibold">Your browser</div>
      <p className="max-w-xs text-xs text-[hsl(240_8%_45%)]">
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
  const showLive = activeTab?.live === true;
  const waitingForPane =
    activeAgentId !== null &&
    apps.selectedAgentId !== null &&
    activeAgentId !== apps.selectedAgentId;
  return (
    <AppDrawerShell open={open} label="Browser drawer" testId="browser-app-drawer" variant="full">
      <div className="flex items-center gap-2.5 border-b border-gray-200/90 px-3.5 py-3 text-[13px]">
        <Globe className="h-[18px] w-[18px] flex-none" strokeWidth={1.7} />
        <b className="font-semibold">Browser</b>
        {showLive && (
          <span
            data-testid="browser-drawer-live"
            className="rounded-full bg-red-500 px-2 py-0.5 text-[11px] font-semibold text-white"
          >
            LIVE
          </span>
        )}
      </div>
      <div
        role="tablist"
        aria-label="Browser tabs"
        className="flex gap-1.5 overflow-x-auto px-3.5 pt-2.5"
      >
        <DrawerTab
          testId="browser-tab-root"
          selected={activeAgentId === null}
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
      <div className="flex min-h-0 flex-1 flex-col border-t border-gray-200/90">
        {activeAgentId === null && <RootBrowserEmptyState />}
        {waitingForPane && (
          <div className="flex flex-1 items-center justify-center text-xs text-[hsl(240_8%_45%)]">
            Opening agent…
          </div>
        )}
        <div
          ref={apps.setSlot}
          data-testid="browser-drawer-slot"
          className={cn('min-h-0 flex-1 flex-col', activeAgentId === null ? 'hidden' : 'flex')}
        />
      </div>
    </AppDrawerShell>
  );
}
