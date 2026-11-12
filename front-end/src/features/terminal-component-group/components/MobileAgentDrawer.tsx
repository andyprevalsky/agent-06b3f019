/**
 * STATE MACHINE: MobileAgentDrawer
 *
 * OPEN STATE:
 * [CLOSED] --tap hamburger--> [OPEN]
 * [OPEN] --select agent / create agent / overlay tap / Esc / close--> [CLOSED]
 *
 * TAB STATE (while OPEN):
 * [AGENTS] <--tap "Agents"--         --tap "Notifications"--> [NOTIFICATIONS]
 *   |  New Agent + Search + SidebarAgentList  |  AttentionInboxContent
 *
 * Mobile-only slide-over (opens from the RIGHT) that surfaces BOTH the agent
 * list (the desktop AppSidebar is `hidden md:flex`, so it's otherwise
 * unreachable) AND the attention/notification inbox behind tabs. The unanswered
 * notification count trails as a red badge on BOTH the hamburger trigger and the
 * Notifications tab.
 *
 * SYSTEM CONTEXT:
 * mobile user tap -> TerminalHeader (mobile bar) -> MobileAgentDrawer
 *   -> onSelectAgent (agent list, same handler as the desktop rail)
 *   -> AttentionInboxContent (respond/skip/reject, same handlers as the bell modal)
 *
 * Attention data comes from the app-wide AttentionRequestsProvider, not a local
 * subscription: this drawer and the desktop bell used to open a realtime channel
 * and a 10s poll each. The same feed also drives the agent rows' needs-help
 * indicator via `attentionAgentIds`.
 *
 * Desktop is unaffected: TerminalHeader renders this only below the md
 * breakpoint (the desktop AttentionInbox bell owns notifications there).
 *
 * SAFE AREAS (installed PWA): content pads by the status-bar inset on top and
 * the home-indicator inset at the bottom (Logout stays tappable); the Sheet's
 * close target sits below the status bar at the right of the tab row, which
 * leaves room for it (pr-12). Row menus use the shared menu layer (z 220),
 * above the Sheet (211); Rename opens later on the same modal tier, so on top.
 *
 * ROSE HEADER (roseHeader, the Rose Desktop mobile header): the hamburger sits
 * on the header's LEFT with a 40px target and opens the drawer from the LEFT
 * (the left bar's place); no count badge on it — the pill's bell carries the
 * unanswered count. The drawer content is unchanged.
 *
 * COVER: once the slide-in finishes, the opaque full-screen drawer hides the
 * whole app, so the app shell stops painting and its ambient animations hold
 * (lib/appCover). Closing uncovers it before the slide-out's first frame.
 */

import { useLayoutEffect, useRef, useState } from 'react';
import { LogOut, Menu } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { coverApp, uncoverApp } from '@/lib/appCover';
import { cn } from '@/lib/utils';

import SidebarAgentList from './SidebarAgentList';
import { RoseMobileAgentList } from './rose-sidebar/RoseMobileAgentList';
import { RoseNewAgentButton, RoseSearchRow } from './rose-sidebar/RoseSidebarChrome';
import { SidebarCreateAgentButton, SidebarSearch } from './SidebarChrome';
import { useAgentRowActions } from './useAgentRowActions';
import { useSidebarSearch } from './useSidebarSearch';
import { AttentionInboxContent } from './attention-inbox/AttentionInboxContent';
import { unansweredCount } from './attention-inbox/useAttentionRequests';
import {
  unansweredAgentIds,
  useAttentionRequestsContext,
} from './attention-inbox/attentionRequestsContext';
import type { Agent } from '../hooks';

type DrawerTab = 'agents' | 'notifications';

interface MobileAgentDrawerProps {
  onResumeAgent?: (agentId: string) => Promise<void>;
  resumingAgentId?: string | null;
  realtimeReady?: boolean;
  agents: Agent[];
  isLoadingAgents: boolean;
  /** False until the first agent load settles; background polls never reset it. */
  hasLoadedAgents: boolean;
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string | null) => void;
  onCreateAgent: () => void;
  /** Reload the agent list after a row mutation (rename/pin/archive). */
  onRefreshAgents: () => void | Promise<void>;
  isSignedIn: boolean;
  onLoginClick: () => void;
  onLogout: () => void;
  /** Rose Desktop mobile header: left trigger/side, 40px target, no trigger badge. */
  roseHeader?: boolean;
}

function CountBadge({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        'flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white',
        className,
      )}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

function TabButton({
  active,
  onClick,
  label,
  badge = 0,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  badge?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex flex-1 items-center justify-center gap-2 rounded-lg py-2 text-sm font-medium transition-colors',
        active
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
      <CountBadge count={badge} />
    </button>
  );
}

export default function MobileAgentDrawer({
  agents,
  isLoadingAgents,
  hasLoadedAgents,
  selectedAgentId,
  onSelectAgent,
  onCreateAgent,
  onRefreshAgents,
  isSignedIn,
  onLoginClick,
  onLogout,
  roseHeader = false,
}: MobileAgentDrawerProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<DrawerTab>('agents');
  const [searchQuery, setSearchQuery] = useState('');
  const search = useSidebarSearch(agents, searchQuery);
  const loginAfterCloseRef = useRef(false);

  // Shared app-wide subscription (see AttentionRequestsProvider) — the drawer
  // used to open its own channel + poll loop alongside the desktop bell's.
  const { requests, refetch } = useAttentionRequestsContext();
  const { handlers, renameDialog } = useAgentRowActions({
    onRefresh: onRefreshAgents,
    onRefreshAttention: refetch,
    selectedAgentId,
    onSelectAgent,
  });
  const notifCount = isSignedIn ? unansweredCount(requests) : 0;
  const attentionAgentIds = isSignedIn ? unansweredAgentIds(requests) : undefined;

  const handleSelectAgent = (agentId: string | null) => {
    onSelectAgent(agentId);
    setOpen(false);
  };

  const handleCreateAgent = () => {
    onCreateAgent();
    setOpen(false);
  };

  const handleLogin = () => {
    loginAfterCloseRef.current = true;
    setOpen(false);
  };

  const handleCloseAutoFocus = (event: Event) => {
    if (!loginAfterCloseRef.current) return;

    // Radix restores focus to the Sheet trigger as it closes. Opening the auth
    // Dialog before that handoff completes makes the new Dialog dismiss itself.
    event.preventDefault();
    loginAfterCloseRef.current = false;
    window.setTimeout(onLoginClick, 0);
  };

  // Uncover in a layout effect: the app is visible again in the same frame the
  // slide-out starts, never a frame later.
  useLayoutEffect(() => {
    if (!open) uncoverApp();
  }, [open]);
  useLayoutEffect(() => uncoverApp, []);

  const handleLogout = () => {
    onLogout();
    setOpen(false);
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label="Open menu"
          className={cn(
            'relative flex items-center justify-center rounded-lg transition-colors md:hidden',
            roseHeader
              ? 'h-10 w-10 text-[hsl(240_8%_45%)] hover:text-foreground dark:text-[#a3a39d] dark:hover:text-[#ecece8]'
              : 'h-9 w-9 hover:bg-muted',
          )}
        >
          <Menu className={cn('h-5 w-5', !roseHeader && 'text-foreground')} />
          {!roseHeader && <CountBadge count={notifCount} className="absolute -right-1 -top-1" />}
        </button>
      </SheetTrigger>
      <SheetContent
        side={roseHeader ? 'left' : 'right'}
        onCloseAutoFocus={handleCloseAutoFocus}
        onAnimationEnd={(event) => {
          // Only the drawer's own slide-in, not animations of its contents.
          if (open && event.target === event.currentTarget) coverApp(event.currentTarget);
        }}
        onEscapeKeyDown={(event) => {
          if (event.target instanceof HTMLInputElement && event.target.dataset.projectNameEditor)
            event.preventDefault();
        }}
        className="flex w-screen max-w-none flex-col p-0 pt-[var(--safe-area-inset-top)] pb-[var(--safe-area-inset-bottom)]"
      >
        <SheetTitle className="sr-only">Menu</SheetTitle>
        <SheetDescription className="sr-only">Your agents and notifications</SheetDescription>

        {isSignedIn ? (
          <>
            <div className="flex gap-1 border-b border-border bg-muted/50 p-1.5 pr-12">
              <TabButton
                active={tab === 'agents'}
                onClick={() => setTab('agents')}
                label="Agents"
              />
              <TabButton
                active={tab === 'notifications'}
                onClick={() => setTab('notifications')}
                label="Notifications"
                badge={notifCount}
              />
            </div>

            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {tab === 'agents' ? (
                <>
                  {roseHeader ? (
                    <>
                      <RoseNewAgentButton isExpanded onClick={handleCreateAgent} />
                    </>
                  ) : (
                    <SidebarCreateAgentButton
                      isCollapsed={false}
                      onCreateAgent={handleCreateAgent}
                    />
                  )}
                  {roseHeader ? (
                    <RoseSearchRow isExpanded value={searchQuery} onChange={setSearchQuery} />
                  ) : (
                    <SidebarSearch
                      isCollapsed={false}
                      value={searchQuery}
                      onChange={setSearchQuery}
                    />
                  )}
                  {roseHeader ? (
                    <RoseMobileAgentList
                      agents={search.agents}
                      selectedAgentId={selectedAgentId}
                      onSelectAgent={handleSelectAgent}
                      onClose={() => setOpen(false)}
                      handlers={handlers}
                      attentionAgentIds={attentionAgentIds}
                      query={searchQuery}
                      contentMatchAgentIds={search.contentMatchAgentIds}
                      isLoading={isLoadingAgents && !hasLoadedAgents}
                      isSearching={search.isSearching}
                      searchError={search.searchError}
                    />
                  ) : (
                    <SidebarAgentList
                      agents={search.agents}
                      isLoadingAgents={isLoadingAgents}
                      selectedAgentId={selectedAgentId}
                      onSelectAgent={handleSelectAgent}
                      attentionAgentIds={attentionAgentIds}
                      isCollapsed={false}
                      query={searchQuery}
                      contentMatchAgentIds={search.contentMatchAgentIds}
                      isSearching={search.isSearching}
                      searchError={search.searchError}
                      {...handlers}
                    />
                  )}
                </>
              ) : (
                <div className="flex-1 overflow-y-auto p-3">
                  <AttentionInboxContent
                    requests={requests}
                    refetch={refetch}
                    isActive={open && tab === 'notifications'}
                    onSelectAgent={handleSelectAgent}
                    onClose={() => setOpen(false)}
                  />
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
            Sign in to view your agents and notifications.
          </div>
        )}

        <div className="mt-auto border-t border-border p-3">
          {isSignedIn ? (
            <Button variant="ghost" onClick={handleLogout} className="w-full justify-start">
              <LogOut className="mr-2 h-4 w-4" />
              Logout
            </Button>
          ) : (
            <Button onClick={handleLogin} className="w-full">
              <LogOut className="mr-2 h-4 w-4 rotate-180" />
              Login
            </Button>
          )}
        </div>
      </SheetContent>
      {/* Mounted as a Sheet sibling, not inside SheetContent: nesting a modal
          Dialog inside the Sheet's focus scope makes the input lose focus the
          moment it opens (same class of handoff bug as handleCloseAutoFocus). */}
      {renameDialog}
    </Sheet>
  );
}
