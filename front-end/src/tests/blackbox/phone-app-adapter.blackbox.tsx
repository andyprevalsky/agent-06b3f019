/** Exact selected-agent binding; no phone provision or provider traffic. */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentContext } from '@/features/terminal-component-group/hooks';
import { RoseAppsContext } from '@/features/terminal-component-group/components/rose-apps/roseAppsState';
import { PhoneAppScreen } from '@/features/terminal-component-group/components/rose-apps/PhoneAppScreen';
import type { Message } from '@/features/terminal-component-group/hooks';
import type { AgentContextValue } from '@/features/agent-context/types';
vi.mock('@/lib/api/client', () => ({
  API_BASE_WITH_PATH: 'http://localhost:3001/api',
  getAuthHeaders: () => ({ Authorization: 'Bearer synthetic-user' }),
}));
import type { RoseAppsValue } from '@/features/terminal-component-group/components/rose-apps/roseAppsState';
const event = (task = 'task-a'): Message => ({
  message_id: 'phone-event',
  role: 'TOOL',
  text: '',
  timestamp: new Date().toISOString(),
  metadata: { task_id: task, toolName: 'phone', action_type: 'phone' },
});
let requests: string[], posts: unknown[], lease: Record<string, unknown>;
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
function view(
  selected: string | null = 'agent-a',
  loaded = 'agent-a',
  messages: Message[] = [event()],
  readOnly = false,
) {
  return (
    <RoseAppsContext.Provider
      value={
        {
          selectedAgentId: selected,
          tabs: [{ agentId: 'agent-a', taskId: 'task-a', live: true }],
        } as RoseAppsValue
      }
    >
      <AgentContext.Provider
        value={
          {
            agent: { agent_id: loaded },
            selectedAgentId: selected,
            messages,
            isLoadingAgent: false,
            inspectionContext: readOnly ? {} : null,
          } as AgentContextValue
        }
      >
        <PhoneAppScreen />
      </AgentContext.Provider>
    </RoseAppsContext.Provider>
  );
}
beforeEach(() => {
  requests = [];
  posts = [];
  lease = {
    id: 'lease-a',
    agentId: 'agent-a',
    browserTaskId: 'task-a',
    status: 'ACTIVE',
    controlOwner: 'agent',
    attentionRequestId: null,
    revision: 1,
  };
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:private-frame');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      if (init?.method === 'POST') posts.push(JSON.parse(String(init.body)));
      if (url.endsWith('/interactions/task-a'))
        return json({ lease, cursor: 0, lastOperation: null, pendingOperation: null });
      if (url.endsWith('/frame'))
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { 'Content-Type': 'image/png' },
        });
      if (url.endsWith('/control')) {
        lease = { ...lease, controlOwner: 'user' };
        return json({ lease });
      }
      if (url.endsWith('/operations'))
        return json({
          operation: {
            id: 'bounds',
            operation: 'screen.bounds',
            status: 'SUCCEEDED',
            cursor: 1,
            result: { x: 0, y: 0, w: 390, h: 844 },
          },
        });
      return new Response(null, { status: 404 });
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('does not request a phone from Home or stale selected-agent state', () => {
  const v = render(view(null));
  expect(screen.getByText('Select an agent to view its phone.')).toBeVisible();
  v.rerender(view('agent-b', 'agent-a'));
  expect(screen.getByText('Loading this agent’s phone…')).toBeVisible();
  expect(requests).toEqual([]);
});
it('never creates a session for a tab without phone activity or an ambiguous interaction', () => {
  const v = render(view('agent-a', 'agent-a', []));
  expect(screen.getByText('No active phone interaction for this agent.')).toBeVisible();
  v.rerender(view('agent-a', 'agent-a', [event(), { ...event('task-b'), message_id: 'second' }]));
  expect(requests).toEqual([]);
});
it('shows only its owned private frame, never auto-takes control; unmount revokes it', async () => {
  const v = render(view());
  expect(await screen.findByAltText('Cloud iPhone screen')).toHaveAttribute(
    'src',
    'blob:private-frame',
  );
  expect(posts).toEqual([]);
  expect(screen.getByRole('region', { name: 'Cloud iPhone' })).toHaveAttribute('data-amp-block');
  v.unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:private-frame');
});
it.each([{ agentId: 'other-agent' }, { browserTaskId: 'other-task' }])(
  'rejects a foreign owner/task lease before any frame read %j',
  async (other) => {
    lease = { ...lease, ...other };
    render(view());
    expect(
      await screen.findByRole('status', { name: 'Phone connection unavailable' }),
    ).toBeVisible();
    expect(requests.some((url) => url.endsWith('/frame'))).toBe(false);
    expect(posts).toEqual([]);
  },
);
it('fails closed when the deployed API is unavailable', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 404 })),
  );
  render(view());
  expect(await screen.findByRole('status', { name: 'Phone connection unavailable' })).toBeVisible();
  expect(screen.queryByAltText('Cloud iPhone screen')).toBeNull();
});
it('retains passive inspection without control or bounds mutations', async () => {
  render(view('agent-a', 'agent-a', [event()], true));
  await screen.findByAltText('Cloud iPhone screen');
  expect(screen.queryByRole('button', { name: /Take control/i })).toBeNull();
  expect(posts).toEqual([]);
});
