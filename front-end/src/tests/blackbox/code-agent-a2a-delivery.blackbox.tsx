/**
 * Blackbox: a Rose → code-agent message delivered as an a2a row renders once
 * (agentGraphSendService: the received row names its CLI turn, code_turn_id), in
 * the code-agent view (folded into the root transcript's "Worked for …" history
 * as a comms activity, unframed) and never in the root transcript's code-agent
 * row (one plain row: no transcript under it). Rose's goal is the view's user
 * prompt, never "You →".
 */
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import { CodeAgentConversationView } from '@/features/terminal-component-group/components/code-agent-view/CodeAgentConversationView';
import { resetCodeAgentLocalState } from '@/features/terminal-component-group/hooks/codeAgentLocalState';
import type { Message } from '@/lib/api';
import { codeSessionMessages } from '@/features/terminal-component-group/hooks/codeSessionTurns';

import {
  ROOT_AGENT_ID,
  WithAgent,
  a2aTimelineMessage,
  chipMessage,
  eventsMessage,
  renderChip,
  signIn,
} from './code-agent-steering.fixtures';
import { renderWithProviders } from './test-wrapper';

const FRAMED_REPLY =
  '[Message from Root agent, agent_id root-agent-1. Reply with: rose-agents send root-agent-1 "<text>"]\n\nThanks, close the session.';

const { fetchSession } = vi.hoisted(() => ({ fetchSession: vi.fn().mockResolvedValue(null) }));
vi.mock('@/features/terminal-component-group/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/terminal-component-group/api')>()),
  fetchCodeAgentSession: fetchSession,
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    loadAddon() {}
    open() {}
    write() {}
    dispose() {}
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));

/** The code-agent view of task-1 (read-only: no query box) over the owner's rows. */
function renderCodeView(messages: Message[]) {
  renderWithProviders(
    createElement(
      WithAgent,
      { messages },
      createElement(CodeAgentConversationView, {
        codeAgent: {
          taskId: 'task-1',
          ownerAgentId: ROOT_AGENT_ID,
          provider: 'codex',
          title: 'Chart BTC',
          status: 'COMPLETED',
        },
        readOnlyMessage: 'read only',
      }),
    ),
    { roseDesktop: true },
  );
  return screen.getByTestId('code-agent-view');
}

/** Expand every "Worked for …" row of the view; returns their histories. */
async function expandWork(view: HTMLElement): Promise<HTMLElement[]> {
  const groups = within(view).getAllByTestId('trajectory-work-group');
  for (const group of groups) {
    const toggle = within(group).getAllByRole('button')[0];
    if (toggle.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle);
  }
  await waitFor(() =>
    expect(within(view).getAllByTestId('trajectory-work-history')).toHaveLength(groups.length),
  );
  return within(view).getAllByTestId('trajectory-work-history');
}

const a2aRows = (scope: HTMLElement) =>
  within(scope)
    .queryAllByTestId('a2a-row')
    .map((r) => [r.getAttribute('data-a2a-direction'), r.textContent]);

beforeEach(() => {
  resetCodeAgentLocalState();
  fetchSession.mockClear();
  signIn();
});

describe('Rose → code-agent delivery renders once', () => {
  it('a real rose-agents send session: routing tool, canonical rows and mirror fold into the work', async () => {
    // agentGraphSendService shape: Codex runs `rose-agents send parent …`; the backend
    // writes the canonical agent_message row (plus a replayed mirror with the same
    // a2a.message_id), then Rose's reply arrives as a received row.
    const sent = a2aTimelineMessage('sent', 'Chart pushed to main.', 'a2a-1');
    sent.timestamp = new Date(1600).toISOString();
    const mirror = { ...sent, message_id: 'a2a-1-mirror' };
    const reply = a2aTimelineMessage('received', 'Thanks, close the session.', 'a2a-2');
    reply.timestamp = new Date(1700).toISOString();
    // deliverToCodeAgent: the received row names the CLI turn it was delivered as.
    (reply.metadata as Record<string, unknown>).code_turn_id = 'a2a-77c1';
    const messages = [
      eventsMessage([
        {
          id: 'goal',
          seq: 0,
          type: 'message',
          role: 'user',
          sender: 'agent',
          text: 'Chart BTC',
          ts: 900,
        },
        { id: 'start', seq: 1, type: 'turn', event: 'started', turn_id: 'one', ts: 1000 },
        {
          id: 'send',
          seq: 2,
          type: 'tool',
          turn_id: 'one',
          ts: 1500,
          tool: {
            name: 'Run',
            target: 'rose-agents send parent "Chart pushed to main."',
            activity_kind: 'exec',
            result: { status: 'ok', exit_code: 0 },
          },
        },
        {
          id: 'end',
          seq: 3,
          type: 'turn',
          event: 'ended',
          turn_id: 'one',
          ts: 2000,
          turn_outcome: 'completed',
        },
        // The session's own copy of Rose's reply: a sender-agent user turn, LLM-framed.
        {
          id: 'turn:a2a-77c1',
          seq: 4,
          type: 'message',
          role: 'user',
          sender: 'agent',
          client_message_id: 'a2a-77c1',
          turn_id: 'two',
          text: FRAMED_REPLY,
          ts: 2100,
        },
      ]),
      sent,
      mirror,
      reply,
    ];
    // The projection: one comms row per [from, to, message_id] (the mirror folds
    // away), direction from this code agent, and no framed copy of the delivered turn.
    const projected = codeSessionMessages({
      messages,
      taskId: 'task-1',
      ownerAgentId: ROOT_AGENT_ID,
      provider: 'codex',
      sessionState: 'completed',
      sessionEndedAt: null,
      echoes: [],
    });
    expect(
      projected.flatMap((m) => {
        const a2a = m.metadata?.a2a as { direction?: string; text?: string } | undefined;
        return a2a ? [[a2a.direction, a2a.text]] : [];
      }),
    ).toEqual([
      ['sent', 'Chart pushed to main.'],
      ['received', 'Thanks, close the session.'],
    ]);
    expect(projected.some((m) => m.message_id === 'a2a-1-mirror')).toBe(false);
    expect(projected.filter((m) => m.role === 'USER').map((m) => m.text)).toEqual(['Chart BTC']);
    const view = renderCodeView(messages);
    expect(within(view).queryByTestId('agent-exchange-group')).toBeNull();
    expect(within(view).queryByText(/Agents coordinating/)).toBeNull();
    // Rose's initial goal is the view's user prompt.
    expect(
      within(view).getByText('Chart BTC').closest('[data-message-role="USER"]'),
    ).not.toBeNull();
    // Coordination is never top-level: no a2a row until the work is expanded.
    expect(within(view).queryByTestId('a2a-row')).toBeNull();
    // The routing tool, Codex's send and Rose's reply (its CLI turn) fold into the
    // "Worked for …" work, in order; the replayed mirror folds away.
    const histories = await expandWork(view);
    const rows = histories.flatMap(a2aRows);
    expect(rows).toEqual([
      ['sent', 'Codex → RoseChart pushed to main.'],
      ['received', 'Rose → CodexThanks, close the session.'],
    ]);
    const all = histories.map((h) => h.textContent).join('\n');
    expect(all).toContain('rose-agents send parent');
    expect(all.indexOf('rose-agents send parent')).toBeLessThan(all.indexOf('Chart pushed'));
    // One copy only: the framed native record never renders.
    expect(screen.queryByText(/Message from Root agent/)).toBeNull();
    expect(screen.getAllByText('Thanks, close the session.')).toHaveLength(1);
  });

  it('the view shows a Rose → Codex message once, unframed; the goal is the user prompt, never "You"', async () => {
    const reply = a2aTimelineMessage('received', 'Thanks, close the session.', 'a2a-2');
    (reply.metadata as Record<string, unknown>).code_turn_id = 'a2a-77c1';
    const messages = [
      chipMessage({ state: 'completed', ended_at: '2026-10-20T12:01:00.000Z' }),
      eventsMessage([
        {
          id: 'goal',
          seq: 0,
          type: 'message',
          role: 'user',
          sender: 'agent',
          text: 'Chart BTC',
          ts: '2026-10-20T12:00:01.000Z',
        },
        {
          id: 'turn:a2a-77c1',
          seq: 1,
          type: 'message',
          role: 'user',
          sender: 'agent',
          client_message_id: 'a2a-77c1',
          text: FRAMED_REPLY,
          ts: '2026-10-20T12:00:30.000Z',
        },
      ]),
      reply,
    ];
    const view = renderCodeView(messages);
    expect(
      within(view).getByText('Chart BTC').closest('[data-message-role="USER"]'),
    ).not.toBeNull();
    const histories = await expandWork(view);
    expect(histories.flatMap(a2aRows)).toEqual([
      ['received', 'Rose → CodexThanks, close the session.'],
    ]);
    expect(within(view).queryByText(/Message from Root agent/)).toBeNull();
    expect(within(view).getAllByText(/Thanks, close the session\./)).toHaveLength(1);
    expect(view.textContent).not.toMatch(/You → Codex/);
  });

  it('the root transcript row carries no transcript: neither the goal nor the delivered message', () => {
    const reply = a2aTimelineMessage('received', 'Thanks, close the session.', 'a2a-2');
    (reply.metadata as Record<string, unknown>).code_turn_id = 'a2a-77c1';
    renderChip([
      chipMessage(),
      eventsMessage([
        {
          id: 'goal',
          seq: 0,
          type: 'message',
          role: 'user',
          sender: 'agent',
          text: 'Chart BTC',
          ts: '2026-10-20T12:00:01.000Z',
        },
        {
          id: 'turn:a2a-77c1',
          seq: 1,
          type: 'message',
          role: 'user',
          sender: 'agent',
          client_message_id: 'a2a-77c1',
          text: FRAMED_REPLY,
          ts: '2026-10-20T12:00:30.000Z',
        },
      ]),
      reply,
    ]);
    const row = screen.getByTestId('code-agent-chip');
    expect(screen.queryByTestId('code-agent-transcript')).toBeNull();
    expect(row.textContent).not.toMatch(/Chart BTC|Thanks, close the session|Message from Root/);
    expect(screen.queryByTestId('a2a-row')).toBeNull();
  });
});
