import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AgentContext } from '@/features/agent-context';
import type { AgentContextValue } from '@/features/agent-context/types';
import BrowserStatusBar from '@/features/terminal-component-group/components/BrowserStatusBar';
import type { Message } from '@/lib/api';
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

function makeContext(): AgentContextValue {
  return {
    agent: null,
    applyAgentDetail: () => true,
    inspectionContext: null,
    stagePendingAgentCreation: () => undefined,
    reconcilePendingAgentCreation: async () => undefined,
    rollbackPendingAgentCreation: () => false,
    stageUserMessage: () => ({ confirm: () => {}, drop: () => {} }),
    selectedAgentId: null,
    setSelectedAgentId: () => undefined,
    messages,
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
          <AgentContext.Provider value={makeContext()}>
            <div className="min-h-screen bg-background p-10 text-foreground">
              <div className="mx-auto max-w-4xl space-y-4">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Browser status preview
                </div>
                <BrowserStatusBar taskId="browser-preview" browserUrl="about:blank" />
              </div>
            </div>
          </AgentContext.Provider>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

createRoot(document.getElementById('root')!).render(<PreviewApp />);
