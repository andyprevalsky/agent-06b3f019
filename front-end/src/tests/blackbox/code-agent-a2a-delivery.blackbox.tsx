/**
 * Blackbox: a Rose → code-agent message delivered as an a2a row renders once
 * (agentGraphSendService: the received row names its CLI turn, code_turn_id), in
 * the code-agent view (folded into the turn it started) and in the chip transcript
 * (unframed; Rose's goal reads "Rose →", never "You").
 */
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';

import { CodeSessionMessages } from '@/features/terminal-component-group/components/code-agent-view/CodeSessionMessages';
import { resetCodeAgentLocalState } from '@/features/terminal-component-group/hooks/codeAgentLocalState';

import {
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

beforeEach(() => {
  resetCodeAgentLocalState();
  fetchSession.mockClear();
  signIn();
});

describe('Rose → code-agent delivery renders once', () => {
  it('a real rose-agents send session: routing tool, canonical rows and mirror fold into the turn', () => {
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
    renderWithProviders(
      createElement(
        WithAgent,
        { messages },
        createElement(CodeSessionMessages, {
          c: { provider: 'codex', chipState: 'completed', meta: null } as unknown as Parameters<
            typeof CodeSessionMessages
          >[0]['c'],
          taskId: 'task-1',
          echoes: [],
        }),
      ),
    );
    const transcript = screen.getByTestId('code-agent-transcript');
    expect(within(transcript).queryByTestId('agent-exchange-group')).toBeNull();
    expect(within(transcript).queryByText(/Agents coordinating/)).toBeNull();
    expect(
      within(transcript).getByText('Chart BTC').closest('[data-message-role="USER"]'),
    ).not.toBeNull();
    expect(within(transcript).queryByTestId('a2a-row')).toBeNull();
    // Codex's send folds into turn one; Rose's reply starts turn two (its CLI turn).
    const [one, two] = within(transcript).getAllByTestId('code-work-slot');
    fireEvent.click(within(one).getByRole('button', { name: /Worked/ }));
    fireEvent.click(within(two).getByRole('button', { name: /Work/ }));
    const row = (slot: HTMLElement) =>
      within(slot)
        .getAllByTestId('a2a-row')
        .map((r) => [r.getAttribute('data-a2a-direction'), r.textContent]);
    expect(row(one)).toEqual([['sent', 'Codex → RoseChart pushed to main.']]);
    expect(row(two)).toEqual([['received', 'Rose → CodexThanks, close the session.']]);
    // One copy only: the framed native record never renders.
    expect(screen.queryByText(/Message from Root agent/)).toBeNull();
    expect(screen.getAllByText('Thanks, close the session.')).toHaveLength(1);
  });

  it('the chip transcript shows a Rose → Codex message once, unframed, and the goal as Rose', () => {
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
    const transcript = screen.getByTestId('code-agent-transcript');
    expect(within(transcript).queryByText(/Message from Root agent/)).toBeNull();
    expect(within(transcript).getAllByText(/Thanks, close the session\./)).toHaveLength(1);
    expect(within(transcript).queryByText(/You → Codex/)).toBeNull();
    expect(transcript).toHaveTextContent('Rose → Codex: Chart BTC');
  });
});
