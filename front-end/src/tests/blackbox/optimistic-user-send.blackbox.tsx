/**
 * Mid-run sends: the query box shows Send (not Stop) once it has a draft, the
 * message renders at once with "Sending", and Sending clears only when a root
 * LLM call (the agent's next step) starts after the message was persisted.
 * Every user message keeps its local send time (day-labelled once past) beneath it.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { clearCaptures } from './msw/capture';
import { renderWithProviders } from './test-wrapper';
import {
  agentDetailJson,
  fakeChannel,
  mockSession as mockRealtimeSession,
} from './realtime-subscription.fixtures';
import {
  makeTerminalHookAgent as makeAgent,
  mockTerminalHookSession as mockSession,
} from './terminal-hooks.fixtures';
import type { Message } from '@/lib/api';
import type { InsertMessagePayload } from '@/lib/realtime';

vi.mock('@/lib/realtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/realtime')>()),
  subscribeToAgent: vi.fn(),
  unsubscribe: vi.fn(),
}));
vi.mock('@/hooks/use-toast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-toast')>()),
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}));

import QueryInput from '@/features/terminal-component-group/components/QueryInput';
import { UserBubble } from '@/features/terminal-component-group/components/message-bubble/UserBubble';
import { useMessageSending } from '@/features/terminal/hooks/useMessageSending';
import { handleInsertMessage } from '@/features/agent-context/hooks/realtimeMessageInsert';
import * as RealtimeMod from '@/lib/realtime';
import {
  buildLocalUserMessage,
  carryClientUserMessages,
  confirmLocalUserMessage,
  dropLocalUserMessage,
  settlePickedUpUserMessages,
} from '@/features/agent-context/hooks/optimisticUserMessages';
import { useAgentProvider } from '@/features/agent-context/hooks';
import { formatMessageSentAt } from '@/lib/localDateTime';

const API_BASE = 'http://localhost:3001/api';
const SENT_AT = '2026-11-05T23:36:00.000Z';
const at = (ms: number) => new Date(Date.parse(SENT_AT) + ms).toISOString();

function serverRow(overrides: Partial<Message> = {}): Message {
  return { message_id: 'm-1', timestamp: SENT_AT, text: 'helllo', role: 'USER', ...overrides };
}

function applyInsert(rows: Message[], data: Omit<InsertMessagePayload, 'agentId'>): Message[] {
  let next = rows;
  const noop = () => {};
  handleInsertMessage({ agentId: 'agent-001', ...data }, 'agent-001', {
    setStreamingBubbles: noop,
    setStreamingPlan: noop,
    setStreamingAttention: noop,
    setStreamingTools: noop,
    setMessages: (update) => {
      next = typeof update === 'function' ? update(next) : update;
    },
    dispatchMessage: noop,
  });
  return next;
}

const sending = (rows: Message[]) =>
  rows.filter((row) => row.metadata?.clientDelivery === 'sending').map((row) => row.text);

describe('query box Send vs Stop while the agent runs', () => {
  function renderBox(value: string) {
    const onSubmit = vi.fn();
    const onPause = vi.fn();
    const view = renderWithProviders(
      <QueryInput
        value={value}
        onChange={vi.fn()}
        onSubmit={onSubmit}
        canSubmit={false}
        onPause={onPause}
      />,
    );
    const buttons = screen.getAllByRole('button');
    return { onSubmit, onPause, button: buttons[buttons.length - 1], unmount: view.unmount };
  }

  it('an empty (or whitespace-only) box keeps Stop', async () => {
    for (const value of ['', '   ']) {
      const { onSubmit, onPause, button, unmount } = renderBox(value);
      await userEvent.click(button);
      expect(onPause).toHaveBeenCalledTimes(1);
      expect(onSubmit).not.toHaveBeenCalled();
      unmount();
    }
  });

  it('a typed draft turns the button into Send', async () => {
    const { onSubmit, onPause, button } = renderBox('also check prices');
    await userEvent.click(button);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onPause).not.toHaveBeenCalled();
  });
});

describe('optimistic send to a running agent', () => {
  function args() {
    const confirm = vi.fn();
    const drop = vi.fn();
    return {
      confirm,
      drop,
      props: {
        selectedAgentId: 'agent-001',
        agentDetail: makeAgent({ status: 'ACTIVE' }),
        canSubmitGoals: true,
        isFullySignedIn: true,
        clientSource: 'WEB' as const,
        setCurrentView: vi.fn(),
        setLoginModalOpen: vi.fn(),
        setIsLoadingNetwork: vi.fn(),
        loadAgents: vi.fn(async () => {}),
        stagePendingAgentCreation: vi.fn(),
        reconcilePendingAgentCreation: vi.fn(async () => {}),
        rollbackPendingAgentCreation: vi.fn(() => true),
        stageUserMessage: vi.fn(() => ({ confirm, drop })),
      },
    };
  }

  beforeEach(() => {
    mockSession();
    clearCaptures();
    server.use(
      http.get(`${API_BASE}/attention-requests`, () => HttpResponse.json({ requests: [] })),
    );
  });

  it('stages the bubble and clears the box before the POST returns', async () => {
    let release!: () => void;
    const posted = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.post(`${API_BASE}/agents/:agentId/messages`, async () => {
        await posted;
        return HttpResponse.json(serverRow(), { status: 201 });
      }),
    );
    const { props, confirm, drop } = args();
    const { result } = renderHook(() => useMessageSending(props));
    act(() => result.current.setMessageInput('helllo'));

    let send!: Promise<void>;
    act(() => {
      send = result.current.handleSendMessage();
    });
    expect(props.stageUserMessage).toHaveBeenCalledWith('agent-001', 'helllo');
    expect(result.current.messageInput).toBe('');
    expect(confirm).not.toHaveBeenCalled();

    await act(async () => {
      release();
      await send;
    });
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ message_id: 'm-1' }));
    expect(drop).not.toHaveBeenCalled();
  });

  it('a failed POST removes the bubble and restores the draft', async () => {
    server.use(
      http.post(`${API_BASE}/agents/:agentId/messages`, () =>
        HttpResponse.json({ error: 'boom' }, { status: 500 }),
      ),
    );
    const { props, confirm, drop } = args();
    const { result } = renderHook(() => useMessageSending(props));
    act(() => result.current.setMessageInput('helllo'));
    await act(async () => {
      await result.current.handleSendMessage();
    });
    expect(drop).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(result.current.messageInput).toBe('helllo');
  });
  it('a failed POST keeps the failed text ahead of a draft typed while it was pending', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.post(`${API_BASE}/agents/:agentId/messages`, async () => {
        await pending;
        return HttpResponse.json({ error: 'boom' }, { status: 500 });
      }),
    );
    const { props, drop } = args();
    const { result } = renderHook(() => useMessageSending(props));
    act(() => result.current.setMessageInput('helllo'));
    let send!: Promise<void>;
    act(() => {
      send = result.current.handleSendMessage();
    });
    act(() => result.current.setMessageInput('next thought'));
    await act(async () => {
      release();
      await send;
    });
    expect(drop).toHaveBeenCalledTimes(1);
    expect(result.current.messageInput).toBe('helllo\nnext thought');
  });

  it('a successful POST keeps a draft typed while it was pending', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.post(`${API_BASE}/agents/:agentId/messages`, async () => {
        await pending;
        return HttpResponse.json(serverRow(), { status: 201 });
      }),
    );
    const { props, confirm } = args();
    const { result } = renderHook(() => useMessageSending(props));
    act(() => result.current.setMessageInput('helllo'));
    let send!: Promise<void>;
    act(() => {
      send = result.current.handleSendMessage();
    });
    act(() => result.current.setMessageInput('next thought'));
    await act(async () => {
      release();
      await send;
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(result.current.messageInput).toBe('next thought');
  });
});

describe('optimistic USER row lifecycle', () => {
  it('realtime INSERT swaps the local row in place; the POST reply adds nothing', () => {
    const local = buildLocalUserMessage('helllo');
    let rows: Message[] = [serverRow({ message_id: 'a-0', role: 'ASSISTANT', text: 'working' })];
    rows = applyInsert([...rows, local], {
      id: 'm-1',
      timestamp: SENT_AT,
      text: 'helllo',
      role: 'USER',
    });
    expect(rows.map((row) => row.message_id)).toEqual(['a-0', 'm-1']);
    expect(rows[1].metadata?.clientMessageId).toBe(local.message_id);
    expect(sending(rows)).toEqual(['helllo']);
    rows = confirmLocalUserMessage(rows, local, serverRow());
    expect(rows.map((row) => row.message_id)).toEqual(['a-0', 'm-1']);
    expect(sending(rows)).toEqual(['helllo']);
  });

  it('the POST reply can land first; the later INSERT is a no-op', () => {
    const local = buildLocalUserMessage('helllo');
    let rows = confirmLocalUserMessage([local], local, serverRow());
    rows = applyInsert(rows, { id: 'm-1', timestamp: SENT_AT, text: 'helllo', role: 'USER' });
    expect(rows.map((row) => row.message_id)).toEqual(['m-1']);
    expect(sending(rows)).toEqual(['helllo']);
  });

  it('settles only server rows persisted before the root LLM start', () => {
    const local = buildLocalUserMessage('next');
    const rows = [serverRow(), serverRow({ message_id: 'm-9', timestamp: at(900) }), local].map(
      (row) => ({ ...row, metadata: { ...row.metadata, clientDelivery: 'sending' as const } }),
    );
    const settled = settlePickedUpUserMessages(rows, Date.parse(SENT_AT) + 300);
    expect(settled.map((row) => row.metadata?.clientDelivery)).toEqual([
      undefined,
      'sending',
      'sending',
    ]);
    expect(settlePickedUpUserMessages(settled, 0)).toBe(settled);
  });

  it('dropping a failed send removes only its local row', () => {
    const local = buildLocalUserMessage('helllo');
    const kept = serverRow({ message_id: 'm-0', text: 'earlier' });
    expect(dropLocalUserMessage([kept, local], local.message_id)).toEqual([kept]);
  });

  it('a canonical reload adopts a new server copy and keeps Sending on confirmed rows', () => {
    const old = serverRow({ message_id: 'm-0', text: 'helllo', timestamp: '2026-11-05T23:00:00Z' });
    const local = buildLocalUserMessage('helllo');
    const confirmedOther = {
      ...serverRow({ message_id: 'm-2', text: 'second' }),
      metadata: { clientMessageId: 'local-user:x', clientDelivery: 'sending' as const },
    };
    const canonical = [old, serverRow(), serverRow({ message_id: 'm-2', text: 'second' })];
    const rows = carryClientUserMessages([old, confirmedOther, local], canonical);
    expect(rows.map((row) => row.message_id)).toEqual(['m-0', 'm-1', 'm-2']);
    expect(rows[0].metadata?.clientDelivery).toBeUndefined();
    expect(sending(rows)).toEqual(['helllo', 'second']);
    expect(rows[1].metadata?.clientMessageId).toBe(local.message_id);
  });
});

describe('pickup through the agent provider', () => {
  beforeEach(() => {
    vi.mocked(RealtimeMod.subscribeToAgent).mockReset();
    mockRealtimeSession();
    window.history.replaceState({}, '', '/?agent-id=agent-1');
    server.use(
      http.get(`${API_BASE}/agents/:agentId`, () => HttpResponse.json(agentDetailJson([]))),
      http.get(
        `${API_BASE}/benchmarks/agent-preview/:agentId`,
        () => new HttpResponse(null, { status: 404 }),
      ),
    );
  });
  afterEach(() => window.history.replaceState({}, '', '/'));

  it("the in-flight step's rows keep Sending; the next root LLM call clears it", async () => {
    let handlers: Parameters<typeof RealtimeMod.subscribeToAgent>[1] = {};
    vi.mocked(RealtimeMod.subscribeToAgent).mockImplementation(async (_, h) => {
      handlers = h;
      return fakeChannel();
    });
    const { result } = renderHook(() =>
      useAgentProvider({ user: { id: 'u-1' }, isAuthenticated: true, realtimeReady: true }),
    );
    await waitFor(() => expect(handlers.onInsert).toBeDefined());
    await waitFor(() => expect(result.current.isLoadingAgent).toBe(false));
    const insert = (id: string, ms: number, role: Message['role'], text = '') =>
      handlers.onInsert?.({ agentId: 'agent-1', id, timestamp: at(ms), text, role });
    const stream = (startedMs: number, subAgentId?: string) =>
      handlers.onAssistantStream?.({
        agentId: 'agent-1',
        stream_id: `s-${startedMs}-${subAgentId ?? 'root'}`,
        sequence: 0,
        delta: '',
        done: false,
        llm_started_at_ms: Date.parse(SENT_AT) + startedMs,
        ...(subAgentId ? { subAgentId } : {}),
      });
    const rows = () => result.current.messages;

    act(() => {
      result.current.stageUserMessage('agent-1', 'helllo');
      insert('m-1', 0, 'USER', 'helllo');
    });
    expect(rows().map((row) => row.message_id)).toEqual(['m-1']);
    expect(sending(rows())).toEqual(['helllo']);

    // Recorded case: a background-spawn TOOL row from the step already running
    // landed 123 ms after the message; that step's LLM call started before it.
    act(() => {
      insert('t-1', 123, 'TOOL');
      insert('a-1', 400, 'ASSISTANT', 'x');
      stream(-2000);
      stream(5000, 'explore-1');
    });
    expect(sending(rows())).toEqual(['helllo']);

    act(() => {
      stream(300);
    });
    await waitFor(() => expect(sending(rows())).toEqual([]));
    expect(rows()[0].metadata?.clientMessageId).toMatch(/^local-user:/);

    // A server row that swaps in after its pickup stream began settles at once.
    act(() => {
      result.current.stageUserMessage('agent-1', 'second');
      stream(9000);
    });
    expect(sending(rows())).toEqual(['second']);
    act(() => {
      insert('m-2', 8000, 'USER', 'second');
    });
    await waitFor(() => expect(sending(rows())).toEqual([]));
  });
});

describe('user bubble meta line', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it('keeps the send time on every user message, with Sending to its left until pickup', () => {
    const { rerender } = render(
      <UserBubble
        message={{ ...serverRow(), metadata: { clientMessageId: 'c', clientDelivery: 'sending' } }}
      />,
    );
    const meta = screen.getByTestId('user-message-meta');
    const time = formatMessageSentAt(SENT_AT);
    expect(meta.textContent).toBe(`Sending${time}`);
    expect(screen.getByTestId('user-message-delivery').nextElementSibling?.tagName).toBe('TIME');
    expect(meta.querySelector('time')?.getAttribute('dateTime')).toBe(SENT_AT);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Sending');

    rerender(<UserBubble message={{ ...serverRow(), metadata: { clientMessageId: 'c' } }} />);
    expect(screen.queryByTestId('user-message-delivery')).toBeNull();
    expect(screen.getByTestId('user-message-meta').textContent).toBe(time);
    // The same live region announces the pickup.
    expect(screen.getByRole('status')).toBe(status);
    expect(status).toHaveTextContent('Delivered');

    rerender(<UserBubble message={serverRow({ message_id: 'history' })} />);
    expect(screen.getByTestId('user-message-meta').textContent).toBe(time);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByText('helllo')).toBeInTheDocument();
  });

  it('copies the complete user text and confirms success with a checkmark and Copied', async () => {
    const text = 'first line\nsecond line  with spaces';
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const { rerender } = render(<UserBubble message={serverRow({ text })} />);
    const button = screen.getByRole('button', { name: 'Copy message' });
    expect(button.querySelector('.lucide-copy')).toBeInTheDocument();
    fireEvent.click(button);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Copied' })).toHaveTextContent('Copied'),
    );
    expect(writeText).toHaveBeenCalledWith(text);
    expect(button.querySelector('.lucide-check')).toBeInTheDocument();
    expect(screen.getByTestId('user-message-meta').querySelector('time')).toHaveAttribute(
      'dateTime',
      SENT_AT,
    );

    rerender(<UserBubble message={serverRow({ text: 'next message', message_id: 'm-2' })} />);
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('shows a Copy tooltip when the copy action is hovered', async () => {
    const user = userEvent.setup();
    render(<UserBubble message={serverRow()} />);
    await user.hover(screen.getByRole('button', { name: 'Copy message' }));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Copy');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });

  it('returns to the copy icon after the confirmation expires', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(<UserBubble message={serverRow()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy message' }));
    });
    expect(screen.getByRole('button', { name: 'Copied' })).toHaveTextContent('Copied');
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeInTheDocument();
    expect(screen.queryByText('Copied')).toBeNull();
  });

  it('keeps copy available after a clipboard failure without claiming success', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('permission denied'));
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(<UserBubble message={serverRow()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy message' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(screen.queryByText('Copied')).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('offers copy on resumed messages, but not on attachment-only messages', () => {
    const { rerender } = render(
      <UserBubble
        message={serverRow({ metadata: { codeAgentResume: { status: 'delivered' } } })}
      />,
    );
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeInTheDocument();
    expect(screen.getByTestId('code-agent-resume-status')).toHaveTextContent('Delivered');
    rerender(<UserBubble message={serverRow({ text: '' })} />);
    expect(screen.queryByRole('button', { name: 'Copy message' })).toBeNull();
  });

  it('labels the local calendar day once the message is before today', () => {
    const now = new Date(2026, 10, 5, 15, 40);
    const label = (date: Date) => formatMessageSentAt(date.toISOString(), now);
    expect(label(new Date(2026, 10, 5, 0, 5))).toBe('12:05 AM');
    expect(label(new Date(2026, 10, 5, 15, 36))).toBe('3:36 PM');
    expect(label(new Date(2026, 10, 4, 23, 59))).toBe('Yesterday, 11:59 PM');
    expect(label(new Date(2026, 10, 3, 9, 0))).toBe('2 days ago, 9:00 AM');
    expect(label(new Date(2026, 9, 26, 15, 36))).toBe('10 days ago, 3:36 PM');
    expect(label(new Date(2026, 9, 25, 15, 36))).toBe('October 25th 2026, 3:36 PM');
    expect(label(new Date(2026, 9, 1, 8, 0))).toBe('October 1st 2026, 8:00 AM');
    expect(label(new Date(2026, 8, 22, 8, 0))).toBe('September 22nd 2026, 8:00 AM');
    expect(label(new Date(2026, 8, 13, 8, 0))).toBe('September 13th 2026, 8:00 AM');
    expect(formatMessageSentAt('not a date', now)).toBe('');
  });
});
