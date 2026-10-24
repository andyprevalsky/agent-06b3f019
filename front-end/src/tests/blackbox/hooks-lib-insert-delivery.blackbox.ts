import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import type { Message } from '@/lib/api';
import type { StreamingBubble, StreamingTool } from '@/features/agent-context/types';
import type { InsertMessagePayload } from '@/lib/realtime';
import { useRealtimeSubscription } from '@/features/agent-context/hooks/useRealtimeSubscription';
import { deduplicateToolMessages } from '@/features/terminal-component-group/hooks/deduplicateToolMessages';
import { server } from './msw/server';
import {
  API_BASE,
  agentDetailJson,
  fakeChannel,
  makeDeps,
  mockSession,
} from './realtime-subscription.fixtures';
import * as realtime from '@/lib/realtime';

vi.mock('@/lib/realtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/realtime')>()),
  subscribeToAgent: vi.fn(),
  unsubscribe: vi.fn(),
}));

type Handlers = Parameters<typeof realtime.subscribeToAgent>[1];
const insert: InsertMessagePayload = {
  agentId: 'agent-1',
  id: 'committed-plan',
  timestamp: '2026-10-13T01:34:15.736Z',
  text: 'Plan saved',
  role: 'TOOL',
  metadata: { toolName: 'set_plan', toolStatus: 'FINISHED', toolCallId: 'plan-call' },
};

describe('committed INSERT delivery', () => {
  beforeEach(() => {
    vi.mocked(realtime.subscribeToAgent).mockReset();
    server.use(
      http.get(`${API_BASE}/benchmarks/agent-preview/:agentId`, () =>
        HttpResponse.json(agentDetailJson([])),
      ),
    );
  });

  it('ignores a repeated INSERT before clearing a newer stream or dispatching again', async () => {
    let handlers: Handlers = {};
    vi.mocked(realtime.subscribeToAgent).mockImplementation(async (_, next) => {
      handlers = next;
      return fakeChannel();
    });
    const deps = makeDeps();
    const hook = renderHook(() => useRealtimeSubscription(deps));
    await waitFor(() => expect(realtime.subscribeToAgent).toHaveBeenCalledOnce());
    act(() => handlers.onInsert?.(insert));
    vi.mocked(deps.setStreamingPlan).mockClear();
    act(() => handlers.onInsert?.(insert));
    expect(deps.dispatchMessage).toHaveBeenCalledOnce();
    expect(deps.setStreamingPlan).not.toHaveBeenCalled();
    hook.unmount();
  });

  it('keeps INSERT deduplication across a channel reconnect', async () => {
    let handlers: Handlers = {};
    vi.mocked(realtime.subscribeToAgent).mockImplementation(async (_, next) => {
      handlers = next;
      return fakeChannel();
    });
    const deps = makeDeps();
    const hook = renderHook(
      ({ reconnect }) => useRealtimeSubscription({ ...deps, forceResubscribeCounter: reconnect }),
      { initialProps: { reconnect: 0 } },
    );
    await waitFor(() => expect(realtime.subscribeToAgent).toHaveBeenCalledOnce());
    act(() => handlers.onInsert?.(insert));
    hook.rerender({ reconnect: 1 });
    await waitFor(() => expect(realtime.subscribeToAgent).toHaveBeenCalledTimes(2));
    act(() => handlers.onInsert?.(insert));
    expect(deps.dispatchMessage).toHaveBeenCalledOnce();
    hook.unmount();
  });

  it('the first INSERT for a snapshot message still settles its stream', async () => {
    let handlers: Handlers = {};
    vi.mocked(realtime.subscribeToAgent).mockImplementation(async (_, next) => {
      handlers = next;
      return fakeChannel();
    });
    // Snapshot reconciliation appends the message without dispatching it or
    // settling the live stream. Its first notification must still do both.
    const assistant = {
      ...insert,
      role: 'ASSISTANT' as const,
      metadata: { streamId: 'completed-stream' },
    };
    let messages: Message[] = [
      {
        message_id: assistant.id,
        timestamp: assistant.timestamp,
        text: assistant.text,
        role: assistant.role,
        metadata: assistant.metadata,
      },
    ];
    let bubbles = new Map<string, StreamingBubble>([
      ['completed-stream', { text: 'old', sequence: 1, done: false }],
      ['newer-stream', { text: 'new', sequence: 1, done: false }],
    ]);
    const deps = makeDeps({
      setMessages: (action) => {
        messages = typeof action === 'function' ? action(messages) : action;
      },
      setStreamingBubbles: (action) => {
        bubbles = typeof action === 'function' ? action(bubbles) : action;
      },
    });
    const hook = renderHook(() => useRealtimeSubscription(deps));
    await waitFor(() => expect(realtime.subscribeToAgent).toHaveBeenCalledOnce());
    act(() => {
      handlers.onInsert?.(assistant);
      handlers.onInsert?.(assistant);
    });
    expect(deps.dispatchMessage).toHaveBeenCalledOnce();
    expect(messages).toHaveLength(1);
    expect([...bubbles.keys()]).toEqual(['newer-stream']);
    hook.unmount();
  });

  it('a wrong-agent INSERT cannot claim the selected agent message ID', async () => {
    let handlers: Handlers = {};
    vi.mocked(realtime.subscribeToAgent).mockImplementation(async (_, next) => {
      handlers = next;
      return fakeChannel();
    });
    const deps = makeDeps();
    const hook = renderHook(() => useRealtimeSubscription(deps));
    await waitFor(() => expect(realtime.subscribeToAgent).toHaveBeenCalledOnce());
    act(() => {
      handlers.onInsert?.({ ...insert, agentId: 'other-agent' });
      handlers.onInsert?.(insert);
    });
    expect(deps.dispatchMessage).toHaveBeenCalledOnce();
    hook.unmount();
  });

  it('the first delayed plan acknowledgement preserves a newer unrelated plan stream', async () => {
    let handlers: Handlers = {};
    vi.mocked(realtime.subscribeToAgent).mockImplementation(async (_, next) => {
      handlers = next;
      return fakeChannel();
    });
    let plan = { stream_id: 'new-plan-stream', tool_call_id: 'new-plan-call', title: 'New plan' };
    const deps = makeDeps({
      setStreamingPlan: (action) => {
        const next = typeof action === 'function' ? action(plan) : action;
        if (next !== null) plan = next;
        else plan = { stream_id: '', tool_call_id: '', title: '' };
      },
    });
    const hook = renderHook(() => useRealtimeSubscription(deps));
    await waitFor(() => expect(realtime.subscribeToAgent).toHaveBeenCalledOnce());
    act(() => handlers.onInsert?.(insert));
    expect(plan.tool_call_id).toBe('new-plan-call');
    expect(deps.dispatchMessage).toHaveBeenCalledOnce();
    hook.unmount();
  });

  it('a delayed assistant INSERT without streamId preserves streams that started later', async () => {
    let handlers: Handlers = {};
    vi.mocked(realtime.subscribeToAgent).mockImplementation(async (_, next) => {
      handlers = next;
      return fakeChannel();
    });
    let bubbles = new Map<string, StreamingBubble>([
      [
        'old-stream',
        {
          text: 'old',
          sequence: 1,
          done: false,
          llmStartedAtMs: Date.parse('2026-10-13T01:34:14Z'),
        },
      ],
      [
        'new-stream',
        {
          text: 'new',
          sequence: 1,
          done: false,
          llmStartedAtMs: Date.parse('2026-10-13T01:34:20Z'),
        },
      ],
    ]);
    const deps = makeDeps({
      setStreamingBubbles: (action) => {
        bubbles = typeof action === 'function' ? action(bubbles) : action;
      },
    });
    const hook = renderHook(() => useRealtimeSubscription(deps));
    await waitFor(() => expect(realtime.subscribeToAgent).toHaveBeenCalledOnce());
    act(() => handlers.onInsert?.({ ...insert, role: 'ASSISTANT', metadata: null }));
    expect([...bubbles.keys()]).toEqual(['new-stream']);
    expect(deps.dispatchMessage).toHaveBeenCalledOnce();
    hook.unmount();
  });

  it('a late browser start cannot resurrect a finished task', async () => {
    let handlers: Handlers = {};
    vi.mocked(realtime.subscribeToAgent).mockImplementation(async (_, next) => {
      handlers = next;
      return fakeChannel();
    });
    let messages: Message[] = [];
    const deps = makeDeps({
      setMessages: (action) => {
        messages = typeof action === 'function' ? action(messages) : action;
      },
    });
    const hook = renderHook(() => useRealtimeSubscription(deps));
    await waitFor(() => expect(realtime.subscribeToAgent).toHaveBeenCalledOnce());
    const browser = (
      id: string,
      toolStatus: NonNullable<InsertMessagePayload['metadata']>['toolStatus'],
    ): InsertMessagePayload => ({
      ...insert,
      id,
      metadata: { toolName: 'spawn_browser_agent', toolCallId: 'browser-a', toolStatus },
    });
    act(() => {
      handlers.onInsert?.(browser('browser-finish', 'FINISHED'));
      handlers.onInsert?.(browser('browser-start', 'IN_PROGRESS'));
      handlers.onInsert?.(browser('browser-start', 'IN_PROGRESS'));
    });
    expect(messages).toHaveLength(2);
    expect(deps.dispatchMessage).toHaveBeenCalledTimes(2);
    expect(deduplicateToolMessages(messages)[0][0]?.metadata?.toolStatus).toBe('FINISHED');
    hook.unmount();
  });

  it('a deferred INSERT hydrates only its committed row through the normal INSERT path', async () => {
    // descend-full69 r004-j0049: the edge WAF refused the 158 KB
    // spawn_claude_code_agent FINISHED frame; only its identifiers arrived.
    let handlers: Handlers = {};
    vi.mocked(realtime.subscribeToAgent).mockImplementation(async (_, next) => {
      handlers = next;
      return fakeChannel();
    });
    const row: Message = {
      message_id: '75e5af12-8b66-4b72-b061-3be30ce4308d',
      timestamp: '2026-10-23T23:18:43.499Z',
      text: `Code-agent SDK event JSON:\n${'x'.repeat(158_000)}`,
      role: 'TOOL',
      metadata: {
        toolName: 'spawn_claude_code_agent',
        toolStatus: 'FINISHED',
        toolCallId: 'call_530ea3ca9bf640358d491ade206558b2',
      },
    };
    mockSession();
    const reads: string[] = [];
    server.use(
      http.get(`${API_BASE}/agents/:agentId/messages/:messageId`, ({ params }) => {
        reads.push(`${String(params.agentId)}/${String(params.messageId)}`);
        return HttpResponse.json({ message: row });
      }),
      http.get(`${API_BASE}/agents/:agentId`, ({ params }) => {
        reads.push(`detail:${String(params.agentId)}`);
        return HttpResponse.json(agentDetailJson([]));
      }),
    );
    let messages: Message[] = [];
    let tools = new Map<string, StreamingTool>([
      ['call_530ea3ca9bf640358d491ade206558b2', {} as StreamingTool],
    ]);
    const deps = makeDeps({
      setMessages: (action) => {
        messages = typeof action === 'function' ? action(messages) : action;
      },
      setStreamingTools: (action) => {
        tools = typeof action === 'function' ? action(tools) : action;
      },
    });
    const hook = renderHook(() => useRealtimeSubscription(deps));
    await waitFor(() => expect(realtime.subscribeToAgent).toHaveBeenCalledOnce());
    reads.length = 0;
    act(() => handlers.onInsertDeferred?.({ agentId: 'agent-1', id: row.message_id }));
    await waitFor(() => expect(deps.dispatchMessage).toHaveBeenCalledOnce());
    expect(vi.mocked(deps.dispatchMessage).mock.calls[0][0]).toMatchObject({
      message_id: row.message_id,
      text: row.text,
      metadata: row.metadata,
    });
    expect(messages.map((message) => message.message_id)).toEqual([row.message_id]);
    expect(tools.size).toBe(0);
    expect(reads).toEqual([`agent-1/${row.message_id}`]);

    // A later duplicate notice or full frame for the same row is a no-op.
    act(() => handlers.onInsertDeferred?.({ agentId: 'agent-1', id: row.message_id }));
    act(() => handlers.onInsertDeferred?.({ agentId: 'other-agent', id: 'other-row' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reads).toHaveLength(1);
    expect(deps.dispatchMessage).toHaveBeenCalledOnce();
    hook.unmount();
  });
});
