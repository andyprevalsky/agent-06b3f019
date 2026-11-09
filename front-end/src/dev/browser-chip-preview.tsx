/**
 * Development preview state: [BROWSER] renders the expandable status chip;
 * [?phone] renders the real fullscreen view with a phone-action fixture;
 * [?phone&native] adds an exact native authentication request for visual QA.
 * Network responses stay outside this fixture and use the normal API client.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TopRightControls } from '@/components/TopRightControls';
import { GlobalControlsLayoutProvider } from '@/components/GlobalControlsLayout';
import { AdminAccountSwitcher } from '@/features/admin-account-switcher/components/AdminAccountSwitcher';
import { InspectionAccountBadge } from '@/features/terminal/components/InspectionAccountBadge';
import { AgentContext } from '@/features/agent-context';
import type { AgentContextValue } from '@/features/agent-context/types';
import BrowserStatusBar from '@/features/terminal-component-group/components/BrowserStatusBar';
import { BrowserStatusBarFullscreen } from '@/features/terminal-component-group/components/browser-status-bar/BrowserStatusBarFullscreen';
import type { Message } from '@/lib/api';
import { getQueryParams } from '@/lib/url';
import { readCriticalReason } from '@/lib/api/phoneAttention';
import '@/index.css';

const messages: Message[] = [
  {
    message_id: 'browser-init',
    timestamp: '2026-05-28T19:30:12Z',
    text: '',
    role: 'TOOL',
    metadata: {
      toolName: 'spawn_browser_agent',
      toolStatus: 'IN_PROGRESS',
      task_id: 'browser-preview',
      action_type: 'session_started',
      title: 'Browser ready',
      browser_session_metadata: {
        provider: 'steel',
        proxy_source: 'steel',
        proxy_location: { city: 'DALLAS', state: 'TX', country: 'US' },
      },
      output_schema: {
        fields: [
          { name: 'purchased_beanie_url', type: 'str', required: true, description: '' },
          { name: 'purchased_beanie_price_usd', type: 'float', required: true, description: '' },
          { name: 'order_confirmation_id', type: 'str', required: true, description: '' },
        ],
      },
      steps_taken: 7,
      total_steps: 30,
    },
  },
  {
    message_id: 'browser-action',
    timestamp: '2026-05-28T19:30:30Z',
    text: '',
    role: 'TOOL',
    metadata: {
      toolName: 'spawn_browser_agent',
      toolStatus: 'IN_PROGRESS',
      task_id: 'browser-preview',
      action_type: 'click',
      title: 'Clicked Proceed to checkout',
      browser_session_metadata: {
        provider: 'steel',
        proxy_source: 'steel',
        proxy_location: { city: 'DALLAS', state: 'TX', country: 'US' },
      },
      steps_taken: 8,
      total_steps: 30,
    },
  },
];

const previewParams = getQueryParams();
const phonePreview = previewParams.has('phone');
const nativePreview = phonePreview && previewParams.has('native');
const criticalReason = readCriticalReason(previewParams.get('reason')) ?? 'password';
const previewMessages: Message[] = phonePreview
  ? [
      ...messages,
      {
        message_id: 'phone-action',
        timestamp: '2026-10-18T20:00:00Z',
        text: '',
        role: 'TOOL',
        metadata: {
          toolName: 'spawn_browser_agent',
          toolStatus: 'IN_PROGRESS',
          task_id: 'browser-preview',
          action_type: 'phone',
          title: 'Using your iPhone',
        },
      },
    ]
  : messages;

if (nativePreview) {
  previewMessages.push({
    message_id: 'phone-authentication',
    timestamp: '2026-10-18T22:00:00Z',
    text: '',
    role: 'TOOL',
    metadata: {
      toolName: 'spawn_browser_agent',
      toolStatus: 'IN_PROGRESS',
      task_id: 'browser-preview',
      action_type: 'auth_assistance',
      title: 'Complete protected phone authentication',
      requestUserAuthentication: {
        requestId: 'qa-phone-attention',
        handoffMode: 'manual_step',
        target: { kind: 'iphone', browserTaskId: 'browser-preview', leaseId: 'qa-phone-lease' },
        criticalReason,
      },
    },
  });
}

function makeContext(): AgentContextValue {
  return {
    agent: null,
    applyAgentDetail: () => true,
    inspectionContext: null,
    stagePendingAgentCreation: () => undefined,
    reconcilePendingAgentCreation: async () => undefined,
    rollbackPendingAgentCreation: () => false,
    stageUserMessage: () => ({ confirm: () => {}, drop: () => {} }),
    selectedAgentId: phonePreview ? 'phone-preview-agent' : null,
    setSelectedAgentId: () => undefined,
    messages: previewMessages,
    streamingBubbles: new Map(),
    streamingPlan: null,
    streamingAttention: null,
    streamingTools: new Map(),
    streamedTextsRef: { current: new Set<string>() },
    registerMessageHandler: () => () => undefined,
    sendMessage: async () => undefined,
    isLoadingAgent: false,
    forceResubscribe: () => undefined,
    isChatMode: false,
  };
}

const queryClient = new QueryClient();

export function PreviewApp() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={100}>
        <MemoryRouter>
          <GlobalControlsLayoutProvider>
            <AgentContext.Provider value={makeContext()}>
              {phonePreview && (
                <>
                  <TopRightControls>
                    <AdminAccountSwitcher isAdmin ownAccountLabel="+19729777432" />
                  </TopRightControls>
                  {previewParams.has('inspection') && (
                    <InspectionAccountBadge
                      context={{
                        user_id: 'preview-owner',
                        name: 'Preview owner',
                        phone: '+15555550101',
                        email: null,
                      }}
                    />
                  )}
                </>
              )}
              {phonePreview && (
                <BrowserStatusBarFullscreen
                  agentId="phone-preview-agent"
                  readOnly={previewParams.has('readonly')}
                  taskId="browser-preview"
                  browserUrl="about:blank"
                  messages={previewMessages}
                  outputSchema={undefined}
                  browserSessionMetadata={null}
                  stepProgress={{ stepsTaken: 8, totalSteps: 30 }}
                  isDisconnected={false}
                  isWaitingForAuthAssistance={nativePreview}
                  isResuming={false}
                  isUserControlling={false}
                  pendingWriteLockApproval={null}
                  onClose={() => window.location.assign('/browser-chip-preview.html')}
                  onResume={() => undefined}
                />
              )}
              <div className="min-h-screen bg-background p-10 text-foreground">
                <div className="mx-auto max-w-4xl space-y-4">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Browser status preview
                  </div>
                  {!phonePreview && (
                    <BrowserStatusBar taskId="browser-preview" browserUrl="about:blank" />
                  )}
                </div>
              </div>
            </AgentContext.Provider>
          </GlobalControlsLayoutProvider>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

createRoot(document.getElementById('root')!).render(<PreviewApp />);
