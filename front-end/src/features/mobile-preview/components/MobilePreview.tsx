/**
 * STATE MACHINE: MobilePreview (dev-only)
 *
 *   ?view=browser ─▶ render real <BrowserAgentPane/> (the Browser drawer's
 *                    agent tab body) in a fixed inset-0 sheet
 *   default       ─▶ faux terminal backdrop + real <MobileAgentDrawer/>
 *                    (drawer opened by clicking its Menu trigger)
 *
 * Local design harness ONLY. Mounts the real mobile components with mock props
 * so the actual rendered UI can be screenshotted/iterated without auth or a live
 * agent. Not linked from anywhere; reachable at /mobile-preview in `vite` dev.
 */

import { useState } from 'react';

import MobileAgentDrawer from '@/features/terminal-component-group/components/MobileAgentDrawer';
import { BrowserAgentPane } from '@/features/terminal-component-group/components/browser-status-bar/BrowserAgentPane';

import { FAKE_PAGE, MOCK_AGENTS, MOCK_BROWSER_MESSAGES, noop } from './mobilePreviewMocks';

export default function MobilePreview() {
  const view = new URLSearchParams(window.location.search).get('view');
  const [isUserControlling, setIsUserControlling] = useState(false);

  if (view === 'browser') {
    return (
      <div className="fixed inset-0 flex flex-col bg-background">
        <BrowserAgentPane
          agentId="a1"
          taskId="task-preview"
          browserUrl={FAKE_PAGE}
          messages={MOCK_BROWSER_MESSAGES}
          outputSchema={undefined}
          browserSessionMetadata={{
            provider: 'steel',
            proxyLocation: { city: 'Ashburn', country: 'US' },
          }}
          stepProgress={{ stepsTaken: 8, totalSteps: 20 }}
          isDisconnected={false}
          isWaitingForAuthAssistance={false}
          isResuming={false}
          isUserControlling={isUserControlling}
          pendingWriteLockApproval={null}
          onResume={() => setIsUserControlling((current) => !current)}
        />
      </div>
    );
  }

  // Drawer view: faux terminal backdrop; Playwright clicks the drawer trigger.
  return (
    <div className="relative min-h-screen bg-background text-foreground">
      <div className="flex items-center gap-2 px-3 py-3 border-b border-border">
        <MobileAgentDrawer
          agents={MOCK_AGENTS}
          isLoadingAgents={false}
          hasLoadedAgents
          selectedAgentId="a1"
          onSelectAgent={noop}
          onCreateAgent={noop}
          onRefreshAgents={noop}
          isSignedIn
          onLoginClick={noop}
          onLogout={noop}
        />
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-orange-400 to-purple-500" />
          <span className="font-semibold">Rose</span>
        </div>
      </div>
      <div className="p-6 text-sm text-muted-foreground">
        Mobile preview backdrop — tap the menu icon (top-left) to open the agent drawer.
      </div>
    </div>
  );
}
