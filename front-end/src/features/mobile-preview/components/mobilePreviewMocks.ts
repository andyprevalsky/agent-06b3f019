/**
 * Mock data for the dev-only MobilePreview harness (MobilePreview.tsx).
 * Kept out of the component module so that file only exports components
 * (react-refresh/only-export-components); app-wiring reads
 * PREVIEW_AGENT_CONTEXT through the feature index.
 */

import type { Agent } from '@/features/terminal-component-group/hooks';
import type { Message } from '@/lib/api/types';

const NOW = '2026-07-20T10:00:00.000Z';

function mockAgent(
  partial: Partial<Agent> & Pick<Agent, 'agent_id' | 'goal' | 'status' | 'progress'>,
): Agent {
  return {
    model: 'rose-labs/rose-1-ultra',
    source: 'WEB',
    reasoning_effort: 'medium',
    status_message: null,
    temporal_workflow_id: 'wf-preview',
    token_count: 0,
    tokens_in: 0,
    tokens_out: 0,
    tool_tokens_in: 0,
    tool_tokens_out: 0,
    tool_cost_cents: 0,
    context_size: 0,
    message_count: 4,
    price_limit_cents: 100,
    tree_cost_cents: 12,
    created_at: NOW,
    updated_at: NOW,
    write_lock_enabled: true,
    ...partial,
  } as Agent;
}

export const MOCK_AGENTS: Agent[] = [
  mockAgent({
    agent_id: 'a1',
    goal: 'Buy me a black Carhartt beanie under $25 and ship it to my apartment',
    status: 'ACTIVE',
    progress: 0.62,
    created_at: '2026-07-20T09:58:00.000Z',
  }),
  mockAgent({
    agent_id: 'a2',
    goal: 'Book a dinner reservation for 4 at a great sushi spot Friday 7pm',
    status: 'ACTIVE',
    progress: 0.28,
    created_at: '2026-07-20T09:40:00.000Z',
  }),
  mockAgent({
    agent_id: 'a3',
    goal: 'Find 5 new potential customers for my startup and draft intro emails',
    status: 'PAUSED',
    progress: 0.45,
    created_at: '2026-07-20T09:10:00.000Z',
  }),
  mockAgent({
    agent_id: 'a4',
    goal: 'Summarize my unread emails from this week',
    status: 'COMPLETED',
    progress: 1,
    created_at: '2026-07-19T18:00:00.000Z',
  }),
];

function msg(partial: Partial<Message> & Pick<Message, 'message_id' | 'text' | 'role'>): Message {
  return { timestamp: NOW, ...partial } as Message;
}

export const MOCK_BROWSER_MESSAGES: Message[] = [
  msg({ message_id: 'm1', role: 'USER', text: 'Buy me a black Carhartt beanie under $25' }),
  msg({
    message_id: 'm2',
    role: 'TOOL',
    text: 'Navigating to amazon.com',
    metadata: { toolName: 'browser', title: 'Navigate to amazon.com', toolStatus: 'FINISHED' },
  }),
  msg({
    message_id: 'm3',
    role: 'TOOL',
    text: 'Searching "carhartt knit beanie black"',
    metadata: {
      toolName: 'browser',
      title: 'Search "carhartt knit beanie black"',
      toolStatus: 'FINISHED',
    },
  }),
  msg({
    message_id: 'm4',
    role: 'TOOL',
    text: 'Adding item to cart',
    metadata: { toolName: 'browser', title: 'Add to cart · $19.99', toolStatus: 'IN_PROGRESS' },
  }),
];

// Same-origin styled page so the iframe reads as a real shopping site in the
// preview (cross-origin sites are X-Frame blocked).
export const FAKE_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`
<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
  body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#fff;color:#111}
  .bar{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #eee;font-size:13px;color:#555}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:14px}
  .card{border:1px solid #eee;border-radius:10px;overflow:hidden}
  .ph{height:110px;background:linear-gradient(135deg,#f2f2f4,#e7e7ea)}
  .meta{padding:8px 10px}.t{font-size:12px;line-height:1.3;color:#222}.p{font-weight:700;margin-top:4px}
  .sel{outline:2px solid #f59e0b;border-radius:10px}
</style></head><body>
  <div class="bar">🔍 carhartt knit beanie black &nbsp;·&nbsp; amazon.com</div>
  <div class="grid">
    <div class="card sel"><div class="ph"></div><div class="meta"><div class="t">Carhartt Men's Knit Cuffed Beanie, Black</div><div class="p">$19.99 · ★ 4.8 (167k)</div></div></div>
    <div class="card"><div class="ph"></div><div class="meta"><div class="t">Carhartt Acrylic Watch Hat</div><div class="p">$16.99</div></div></div>
    <div class="card"><div class="ph"></div><div class="meta"><div class="t">Carhartt Rib Knit Beanie</div><div class="p">$21.99</div></div></div>
    <div class="card"><div class="ph"></div><div class="meta"><div class="t">Carhartt Fleece 2-in-1 Hat</div><div class="p">$24.99</div></div></div>
  </div>
</body></html>`)}`;

export function noop(): void {
  /* preview */
}

export const PREVIEW_AGENT_CONTEXT = {
  agent: MOCK_AGENTS[0],
  applyAgentDetail: () => true,
  inspectionContext: null,
  selectedAgentId: 'a1',
  setSelectedAgentId: noop,
  stagePendingAgentCreation: noop,
  reconcilePendingAgentCreation: async () => {},
  rollbackPendingAgentCreation: () => false,
  stageUserMessage: () => ({ confirm: () => {}, drop: () => {} }),
  messages: MOCK_BROWSER_MESSAGES,
  streamingBubbles: new Map(),
  streamingPlan: null,
  streamingAttention: null,
  streamingTools: new Map(),
  streamedTextsRef: { current: new Set<string>() },
  registerMessageHandler: () => noop,
  sendMessage: async () => {},
  isLoadingAgent: false,
  forceResubscribe: noop,
  isChatMode: false,
};
