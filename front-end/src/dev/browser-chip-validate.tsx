/**
 * Isolated CDP validation harness for BrowserAgentChip — renders the REAL
 * MessageBubble dispatch path (useMessageRouting -> renderChipRoutes) for a mock
 * browser task_complete message, with a mock AgentContext supplying the sibling
 * recording message (real backfilled FilePointer). No realtime/auth gate, so it
 * loads headless. Served at /browser-chip-validate.html.
 */
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AgentContext } from '@/features/agent-context';
import type { AgentContextValue } from '@/features/agent-context/types';
import MessageBubble from '@/features/terminal-component-group/components/MessageBubble';
import type { Message } from '@/lib/api';
import '@/index.css';

const TASK = 't1';
const RECORDING_FP = {
  id: 'd7e1f0ea-1181-4b3b-abfc-71846569b029',
  storage_path:
    '1f85ff25-6e29-4c1b-8739-f917bd101a30/d7e1f0ea-1181-4b3b-abfc-71846569b029_browser-recording-fd6d8d0c-80a6-4b75-8ef1-6063fd10a06c.html',
  original_filename: 'browser-recording.html',
  mime_type: 'text/html',
  size_bytes: 14630431,
  created_at: '2026-06-29T21:29:12.265006Z',
};

const messages: Message[] = [
  {
    message_id: 'step-1',
    timestamp: '2026-06-29T03:41:10Z',
    text: 'Navigated to order.toasttab.com',
    role: 'TOOL',
    metadata: {
      toolName: 'spawn_browser_agent',
      task_id: TASK,
      subAgentId: TASK,
      action_type: 'navigate',
      toolStatus: 'FINISHED',
      title: 'Navigated → order.toasttab.com',
    },
  },
  {
    message_id: 'step-2',
    timestamp: '2026-06-29T03:42:00Z',
    text: 'Clicked The Rocky Sandwich',
    role: 'TOOL',
    metadata: {
      toolName: 'spawn_browser_agent',
      task_id: TASK,
      subAgentId: TASK,
      action_type: 'click',
      toolStatus: 'FINISHED',
      title: 'Clicked "The Rocky Sandwich"',
    },
  },
  {
    message_id: 'rec-1',
    timestamp: '2026-06-29T04:04:28Z',
    text: 'Local browser recording saved',
    role: 'TOOL',
    metadata: {
      toolName: 'spawn_browser_agent',
      task_id: TASK,
      subAgentId: TASK,
      action_type: 'recording',
      toolStatus: 'FINISHED',
      recording_file_pointer: RECORDING_FP,
    },
  },
  {
    message_id: 'complete-1',
    timestamp: '2026-06-29T04:04:30Z',
    text: '**Status**: ✅ SUCCESS — reached The Rocky Sandwich ($21.00); site only accepting scheduled orders.',
    role: 'TOOL',
    metadata: {
      toolName: 'spawn_browser_agent',
      task_id: TASK,
      action_type: 'task_complete',
      toolStatus: 'FINISHED',
      title: 'Browser automation complete',
    },
  },
  // Session-init failure (no task_id, no recording) — must also become a chip.
  {
    message_id: 'initfail-1',
    timestamp: '2026-06-29T03:36:00Z',
    text: 'Exception: Failed to init session: browserType.connectOverCDP: Timeout 30000ms exceeded — wss://connect.steel.dev',
    role: 'TOOL',
    metadata: {
      toolName: 'spawn_browser_agent',
      action_type: 'browser',
      toolStatus: 'ERROR',
      title: 'Browser automation failed',
    },
  },
];

const terminalChipMessages = messages.filter(
  (m) =>
    m.metadata?.toolName === 'spawn_browser_agent' &&
    !m.metadata?.subAgentId &&
    (m.metadata?.toolStatus === 'FINISHED' || m.metadata?.toolStatus === 'ERROR'),
);

function makeContext(): AgentContextValue {
  return {
    agent: null,
    applyAgentDetail: () => true,
    inspectionContext: null,
    stagePendingAgentCreation: () => undefined,
    reconcilePendingAgentCreation: async () => undefined,
    rollbackPendingAgentCreation: () => false,
    stageUserMessage: () => ({ confirm: () => {}, drop: () => {} }),
    selectedAgentId: 'e1fa0fad-02d7-4a3c-983d-ef9739111f32',
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

export function ValidateApp() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={100}>
        <MemoryRouter>
          <AgentContext.Provider value={makeContext()}>
            <div className="min-h-screen bg-background p-10 text-foreground">
              <div className="mx-auto max-w-3xl space-y-2">
                {terminalChipMessages.map((m) => (
                  <MessageBubble key={m.message_id} message={m} />
                ))}
              </div>
            </div>
          </AgentContext.Provider>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

createRoot(document.getElementById('root')!).render(<ValidateApp />);
