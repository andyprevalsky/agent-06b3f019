/**
 * STATE MACHINE: MobileAgentDrawer
 *
 * OPEN STATE:
 * [CLOSED] --tap hamburger--> [OPEN]
 * [OPEN] --select agent / create agent / overlay tap / Esc / close--> [CLOSED]
 *
 * TAB STATE (while OPEN):
 * [AGENTS] <--tap "Agents"--         --tap "Notifications"--> [NOTIFICATIONS]
 *   |  Create Agent + SidebarAgentList        |  AttentionInboxContent
 *
 * Mobile-only slide-over (opens from the RIGHT) that surfaces BOTH the agent
 * list (the desktop AppSidebar is `hidden md:flex`, so it's otherwise
 * unreachable) AND the attention/notification inbox behind tabs. The unanswered
 * notification count trails as a red badge on BOTH the hamburger trigger and the
 * Notifications tab, driven by a single useAttentionRequests subscription.
 *
 * SYSTEM CONTEXT:
 * mobile user tap -> TerminalHeader (mobile bar) -> MobileAgentDrawer
 *   -> onSelectAgent (agent list, same handler as the desktop rail)
 *   -> AttentionInboxContent (respond/skip/reject, same handlers as the bell modal)
 *
 * Desktop is unaffected: TerminalHeader renders this only below the md
 * breakpoint, so the drawer + its subscription never mount on desktop (the
 * desktop AttentionInbox bell owns notifications there).
 */

import { useState } from 'react';
import { LogOut, Menu, Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

import SidebarAgentList from './SidebarAgentList';
import { AttentionInboxContent } from './attention-inbox/AttentionInboxContent';
import { unansweredCount, useAttentionRequests } from './attention-inbox/useAttentionRequests';
import type { Agent } from '../hooks';

type DrawerTab = 'agents' | 'notifications';

interface MobileAgentDrawerProps {
  agents: Agent[];
  isLoadingAgents: boolean;
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string | null) => void;
  onCreateAgent: () => void;
  onResumeAgent: (agentId: string) => Promise<void>;
  resumingAgentId: string | null;
  realtimeReady: boolean;
  isSignedIn: boolean;
  onLoginClick: () => void;
  onLogout: () => void;
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
  selectedAgentId,
  onSelectAgent,
  onCreateAgent,
  onResumeAgent,
  resumingAgentId,
  realtimeReady,
  isSignedIn,
  onLoginClick,
  onLogout,
}: MobileAgentDrawerProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<DrawerTab>('agents');

  const { requests, refetch } = useAttentionRequests(isSignedIn && realtimeReady);
  const notifCount = isSignedIn ? unansweredCount(requests) : 0;

  const handleSelectAgent = (agentId: string | null) => {
    onSelectAgent(agentId);
    setOpen(false);
  };

  const handleCreateAgent = () => {
    onCreateAgent();
    setOpen(false);
  };

  const handleLogin = () => {
    onLoginClick();
    setOpen(false);
  };

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
          className="relative flex h-9 w-9 items-center justify-center rounded-lg transition-colors hover:bg-muted md:hidden"
        >
          <Menu className="h-5 w-5 text-foreground" />
          <CountBadge count={notifCount} className="absolute -right-1 -top-1" />
        </button>
      </SheetTrigger>
      <SheetContent side="right" className="flex w-[min(340px,88vw)] flex-col p-0">
        <SheetTitle className="sr-only">Menu</SheetTitle>
        <SheetDescription className="sr-only">Your agents and notifications</SheetDescription>

        {isSignedIn ? (
          <>
            <div className="flex gap-1 border-b border-border bg-muted/50 p-1.5">
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
                  <div className="p-3">
                    <Button onClick={handleCreateAgent} className="w-full">
                      <Plus className="mr-2 h-4 w-4" />
                      Create Agent
                    </Button>
                  </div>
                  <SidebarAgentList
                    agents={agents}
                    isLoadingAgents={isLoadingAgents}
                    selectedAgentId={selectedAgentId}
                    onSelectAgent={handleSelectAgent}
                    onResumeAgent={onResumeAgent}
                    resumingAgentId={resumingAgentId}
                    isCollapsed={false}
                  />
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
    </Sheet>
  );
}
