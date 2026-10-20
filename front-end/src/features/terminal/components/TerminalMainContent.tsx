/**
 * STATE MACHINE: TerminalMainContent
 *
 * [VIEW] -> browse | settings | integrations | usage | admin-health | benchmarks | network | agents
 * Each view is selected by TerminalContent's currentView state.
 * benchmarks is team-gated (admin allowlist or dev mode) and full-width.
 *
 * PER-USER UI: agents view + selected agent + published agent.panel slot →
 * a sandboxed panel to the right of the chat column (lg+ viewports only).
 */

import { useNavigate } from 'react-router-dom';

import { ScrollArea } from '@/components/ui/scroll-area';
import { BenchmarksView } from '@/features/benchmarks';
import { UserUiSlot } from '@/features/user-ui';
import { useAppData } from '@/hooks/appDataContext';
import { cn } from '@/lib/utils';
import AdminHealth from '@/pages/AdminHealth';
import Browse from '@/pages/Browse';
import Integrations from '@/pages/Integrations';
import Settings from '@/pages/Settings';
import Usage from '@/pages/Usage';

import type { TerminalView } from '../types';
import type { derivePendingApproval, derivePendingGates } from '../hooks/derivations';
import type { useDrippiness } from '../hooks/useDrippiness';
import type { useTerminalAgents } from '../hooks/useTerminalAgents';

import { AgentChatArea } from './AgentChatArea';

interface MainContentProps {
  agents: ReturnType<typeof useTerminalAgents>;
  drip: ReturnType<typeof useDrippiness>;
  currentView: TerminalView;
  models: ReturnType<typeof useAppData>['models'];
  modelsLoading: boolean;
  pendingApproval: ReturnType<typeof derivePendingApproval>;
  pendingGates: ReturnType<typeof derivePendingGates>;
  hasActiveAttention: boolean;
  browserStatusProps: { browsers: { taskId: string; browserUrl: string }[] } | null;
  systemMessages: ReturnType<typeof useTerminalAgents>['messages'];
  BrowserStatusBarCarousel: React.ComponentType<{
    browsers: { taskId: string; browserUrl: string }[];
  }>;
  NetworkView: React.ComponentType;
  sidebarWidthCollapsed: number;
}

export function MainContent(props: MainContentProps) {
  // Full-width views (browse, benchmarks) must clear the fixed sidebar rail —
  // centered views never reach under it, but max-w-none content does.
  const fullWidthView = props.currentView === 'browse' || props.currentView === 'benchmarks';
  const browseOffsetStyle = fullWidthView
    ? ({
        '--browse-sidebar-offset': `${props.sidebarWidthCollapsed}px`,
      } as React.CSSProperties)
    : undefined;
  return (
    <main
      className={cn(
        'flex-1 flex justify-center h-screen overflow-hidden',
        fullWidthView && 'md:pl-[var(--browse-sidebar-offset)]',
      )}
      style={{ height: '100dvh', ...browseOffsetStyle }}
    >
      <div
        className={cn(
          'flex flex-col relative w-full h-full overflow-hidden',
          props.currentView === 'browse' ? 'px-0' : 'px-2 md:px-6',
          isWideView(props.currentView) ? 'max-w-none' : 'max-w-5xl',
        )}
      >
        {props.agents.clientSource === 'WEB' && <DesktopNavLinks />}
        <TerminalViewContent {...props} />
      </div>
      {props.currentView === 'agents' && props.agents.selectedAgentId && (
        <UserUiSlot
          name="agent.panel"
          className="relative z-10 hidden h-full w-80 shrink-0 pb-6 pr-4 pt-16 lg:block xl:w-96"
        />
      )}
    </main>
  );
}

function isWideView(view: TerminalView): boolean {
  return (
    view === 'network' || view === 'browse' || view === 'admin-health' || view === 'benchmarks'
  );
}

function StandardView({ children }: { children: React.ReactNode }) {
  return (
    <ScrollArea className="flex-1 h-full">
      <div className="pt-24 pb-8">{children}</div>
    </ScrollArea>
  );
}

function TerminalViewContent(props: MainContentProps) {
  if (props.currentView === 'browse') return <Browse />;
  if (props.currentView === 'settings')
    return (
      <StandardView>
        <Settings />
      </StandardView>
    );
  if (props.currentView === 'integrations')
    return (
      <StandardView>
        <Integrations />
      </StandardView>
    );
  if (props.currentView === 'usage')
    return (
      <StandardView>
        <Usage />
      </StandardView>
    );
  if (props.currentView === 'admin-health')
    return (
      <StandardView>
        <AdminHealth />
      </StandardView>
    );
  if (props.currentView === 'benchmarks')
    return <BenchmarksView onOpenAgent={props.agents.handleSelectAgent} />;
  if (props.currentView === 'network') return <props.NetworkView />;
  return (
    <AgentChatArea
      agents={props.agents}
      drip={props.drip}
      models={props.models}
      modelsLoading={props.modelsLoading}
      pendingApproval={props.pendingApproval}
      pendingGates={props.pendingGates}
      hasActiveAttentionRequest={props.hasActiveAttention}
      browserStatusProps={props.browserStatusProps}
      systemMessages={props.systemMessages}
      BrowserStatusBarCarousel={props.BrowserStatusBarCarousel}
    />
  );
}

function DesktopNavLinks() {
  const navigate = useNavigate();
  return (
    <div className="hidden md:flex items-center gap-2 absolute top-5 right-2 z-50">
      <button
        onClick={() => navigate('/research')}
        className="px-3 py-1.5 bg-navi-white text-navi-black text-xs font-medium rounded-full border border-border hover:bg-navi-white/80 transition-colors shadow-sm"
      >
        Research
      </button>
      <button
        onClick={() => navigate('/careers')}
        className="px-3 py-1.5 bg-navi-white text-navi-black text-xs font-medium rounded-full border border-border hover:bg-navi-white/80 transition-colors shadow-sm"
      >
        Careers
      </button>
      <a
        href="/download"
        target="_blank"
        rel="noopener noreferrer"
        className="px-3 py-1.5 bg-navi-black text-white text-xs font-medium rounded-full hover:bg-navi-black/80 transition-colors shadow-lg"
      >
        Download
      </a>
    </div>
  );
}
