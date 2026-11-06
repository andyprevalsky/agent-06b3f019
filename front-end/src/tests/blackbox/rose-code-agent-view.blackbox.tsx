/**
 * Blackbox: a code agent opened from the Rose Desktop left bar as its own
 * conversation, through the real Terminal (flag on) with every backend call
 * served by MSW:
 *
 *   GET  /api/agents/code-agents?root_ids=…   → the left-bar rows (W5b batched list)
 *   GET  /api/agents/:ownerId                 → the owner's messages: the session's
 *        spawn_claude_code_agent rows (code_agent snapshot, code_agent_events, …)
 *   POST /api/claude-code-session/:taskId/turns {client_message_id, text, tool_call_id}
 *        → 200 {status:'delivered'} | 409 {error:'This code session has finished…'}
 *
 * Row click → the code agent's view replaces the chat column (no header: the view
 * is titled by its aria-label "<label>: <title>"; its transcript is the root
 * MessageList with the work folded into "Working"/"Worked for …" and no terminal
 * view; the existing query box as its direct channel with the model chip and
 * speed toggle); Escape, the owner row, another row or Home return. In the
 * owner's chat the session is one plain row folded into a work group.
 * Deep link ?agent-id=<owner>&code-agent=<task>.
 * 10k agents: opening reads nothing new (the owner's loaded messages); the
 * stock account never opens it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';

import { buildCodeSession } from '@/features/terminal-component-group/hooks/codeSessionTurns';

import { chipMessage, eventsMessage, LIVE_EVENTS, msg } from './code-agent-steering.fixtures';
import { server } from './msw/server';
import { expandBar } from './rose-sidebar.fixtures';
import {
  API_BASE,
  OWNER,
  TASK,
  liveRows,
  openFromRow,
  ownerChat,
  ownerCodeAgentRow,
  renderOnOwner,
  requests,
  resetRoseViewState,
  restoreRoseViewState,
  row,
  serveBackend,
  urlParams,
} from './rose-code-agent-view.helpers';

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
  resetRoseViewState();
});

afterEach(() => {
  restoreRoseViewState();
});

describe('Rose left bar: a code agent opens as its own conversation (flag on)', () => {
  it('row click replaces the chat column with its titled view, root transcript and direct query box', async () => {
    const user = await renderOnOwner();
    // The owner's chat shows the session as one plain row: title · Running.
    const ownerRow = await ownerCodeAgentRow();
    expect(within(ownerRow).getByTestId('code-agent-title')).toHaveTextContent(
      '3-state speed button',
    );
    expect(within(ownerRow).getByTestId('code-agent-state')).toHaveTextContent('· Running');
    const page = await openFromRow(user);
    // No header: the view is titled by its aria-label (label: the row's title).
    expect(screen.getByRole('region', { name: 'Codex: Make the speed button 3-state' })).toBe(page);
    expect(page).toHaveAttribute('data-code-agent-state', 'live');
    for (const id of [
      'code-agent-view-header',
      'code-agent-view-title',
      'code-agent-view-target',
      'code-agent-view-state',
    ]) {
      expect(within(page).queryByTestId(id)).toBeNull();
    }
    expect(page).not.toHaveTextContent('rose-ui/polish/speed');

    // The transcript is the root MessageList: the turn is ONE running work group
    // holding the thought, narration and tool rows.
    const groups = within(page).getAllByTestId('trajectory-work-group');
    expect(groups).toHaveLength(1);
    const [work] = groups;
    expect(work).toHaveAttribute('data-state', 'running');
    expect(work).toHaveAttribute(
      'data-tool-statuses',
      'thought:FINISHED Read:FINISHED Edit:FINISHED Run:FINISHED',
    );
    expect(within(work).getByTestId('trajectory-activity-line')).toHaveTextContent(
      'Run npx vitest run fast-mode.blackbox.tsx',
    );
    // Running: a compact Working fold; its steps show only once expanded.
    expect(within(page).queryByTestId('trajectory-work-history')).toBeNull();
    expect(within(page).queryAllByTestId('trajectory-history-entry')).toHaveLength(0);
    await user.click(within(work).getByRole('button', { expanded: false }));
    const history = await within(work).findByTestId('trajectory-work-history');
    // The page transcript grows with the column (no 300px chip cap).
    expect(page.querySelector('[class*="max-h-[300px]"]')).toBeNull();
    // Mid-turn narration is a collapsed Thought row (the root transcript's rule).
    expect(history).not.toHaveTextContent('widen the existing toggle to three states');
    for (const thought of within(history).getAllByText('Thought')) await user.click(thought);
    expect(history).toHaveTextContent('widen the existing toggle to three states');
    expect(history).toHaveTextContent('FastModeToggle.tsx');
    // No terminal view: no Transcript / Terminal tabs and no terminal surface.
    expect(within(page).queryByRole('tablist')).toBeNull();
    expect(page.querySelector('.code-agent-terminal-mount')).toBeNull();
    expect(work.closest('.hidden')).toBeNull();

    // The owner's chat is replaced (its row and composer are gone).
    expect(screen.queryByTestId('code-agent-chip')).toBeNull();
    expect(screen.queryByPlaceholderText('Type your message...')).toBeNull();
    const box = within(screen.getByTestId('query-input-layer'));
    expect(box.getByPlaceholderText('Message Codex…')).toBeInTheDocument();
    // The existing query box: the live session's model on the chip, its speed on
    // the toggle, the session's own nub (no Rose pinned tools), the paperclip.
    await waitFor(() =>
      expect(box.getByTestId('query-model-selector')).toHaveTextContent('Test Codex'),
    );
    expect(box.getByTestId('query-model-selector')).not.toBeDisabled();
    expect(box.getByTestId('speed-toggle')).toHaveAttribute('data-state', 'normal');
    expect(box.getByTestId('query-toolbar-nub')).toBeInTheDocument();
    expect(box.queryByTestId('query-pinned-tools')).toBeNull();
    expect(box.getByRole('button', { name: 'Attach files' })).toBeInTheDocument();
    expect(screen.queryByText(/Session settings unavailable|Effective:/)).toBeNull();
    expect(urlParams().get('agent-id')).toBe(OWNER);
    expect(urlParams().get('code-agent')).toBe(TASK);
  });

  it('marks the open code-agent row by weight/color; its owner row is not marked', async () => {
    const user = await renderOnOwner();
    expandBar();
    const owner = screen.getByTestId(`rose-agent-row-${OWNER}`);
    expect(owner).toHaveAttribute('aria-current', 'true');
    expect(row()).not.toHaveAttribute('aria-current');
    await openFromRow(user);
    expect(row()).toHaveAttribute('aria-current', 'true');
    expect(row().className).toContain('font-semibold');
    expect(row().className).toContain('dark:text-[#ecece8]');
    // No fill/ring around the selected row (selection = color/weight only).
    expect(row().className).not.toMatch(/\bbg-|ring-/);
    expect(screen.getByTestId(`rose-agent-row-${OWNER}`)).not.toHaveAttribute('aria-current');
  });

  it('a message from the query box goes to the steer route and appears in the transcript', async () => {
    const user = await renderOnOwner();
    await openFromRow(user);
    const input = screen.getByPlaceholderText('Message Codex…');
    // Untouched settings: the turn carries no model/speed options.
    await waitFor(() =>
      expect(screen.getByTestId('query-model-selector')).toHaveTextContent('Test Codex'),
    );
    await user.type(input, 'Keep the 26px button{Enter}');
    await waitFor(() =>
      expect(requests('POST', `/api/claude-code-session/${TASK}/turns`)).toHaveLength(1),
    );
    const [turn] = requests('POST', `/api/claude-code-session/${TASK}/turns`);
    expect(turn.body).toEqual({
      client_message_id: expect.stringMatching(/^turn-/),
      text: 'Keep the 26px button',
      tool_call_id: `call-${TASK}`,
    });
    // The delivered turn is the person's USER row of the view's root transcript.
    const page = screen.getByTestId('code-agent-view');
    await within(page).findByText('Keep the 26px button');
    expect(
      within(page).getByText('Keep the 26px button').closest('[data-message-role]'),
    ).toHaveAttribute('data-message-role', 'USER');
    expect(input).toHaveValue('');
    // Straight to the session: the owner Rose agent gets no chat message.
    expect(requests('POST', `/api/agents/${OWNER}/messages`)).toHaveLength(0);
  });

  it('keeps attachments and settings draft through failed delivery, then applies native ACK', async () => {
    const file = {
      id: 'uploaded-fe16',
      storage_path: 'user/notes.txt',
      original_filename: 'notes.txt',
      mime_type: 'text/plain',
      size_bytes: 5,
      created_at: '2026-10-20T12:00:00Z',
    };
    let attempts = 0;
    serveBackend({
      turns: () =>
        ++attempts === 1
          ? HttpResponse.json({ error: 'Native turn unavailable' }, { status: 503 })
          : HttpResponse.json({
              status: 'delivered',
              delivery_mode: 'steer',
              turn_id: 'native-1',
              // The session's actual settings for that turn (another catalog model).
              effective_settings: { model: 'gpt-test-2', effort: 'high', speed: 'fast' },
            }),
    });
    server.use(
      http.post(`${API_BASE}/upload`, () => HttpResponse.json({ file_pointer: file })),
      http.get(`${API_BASE}/claude-code-session/:taskId/capabilities`, () =>
        HttpResponse.json({
          effective_settings: { model: 'gpt-test', effort: 'medium', speed: 'standard' },
          models: [
            {
              model: 'gpt-test',
              label: 'Test Codex',
              efforts: ['medium', 'high'],
              speeds: ['standard', 'fast'],
            },
            {
              model: 'gpt-test-2',
              label: 'Test Codex Two',
              efforts: ['medium', 'high'],
              speeds: ['standard', 'fast'],
            },
          ],
        }),
      ),
    );
    const user = await renderOnOwner();
    await openFromRow(user);
    const chip = () => screen.getByTestId('query-model-selector');
    const speed = () => screen.getByTestId('speed-toggle');
    await waitFor(() => expect(chip()).toHaveTextContent('codex/Test Codex'));
    expect(speed()).toHaveAttribute('data-state', 'normal');
    // The next turn's speed is picked on the query box's own speed toggle.
    await user.click(speed());
    expect(speed()).toHaveAttribute('data-state', 'fast');
    await user.upload(
      screen
        .getByTestId('query-input-layer')
        .querySelector('input[type="file"]') as HTMLInputElement,
      new File(['hello'], 'notes.txt', { type: 'text/plain' }),
    );
    await screen.findByText('notes.txt');
    const input = screen.getByPlaceholderText('Message Codex…');
    await user.type(input, 'Inspect this{Enter}');
    await screen.findByText('Native turn unavailable');
    expect(input).toHaveValue('Inspect this');
    expect(screen.getByText('notes.txt')).toBeInTheDocument();
    // A failed delivery applies nothing: the live session's model, the draft speed.
    expect(chip()).toHaveTextContent('codex/Test Codex');
    expect(chip()).not.toHaveTextContent('Test Codex Two');
    expect(speed()).toHaveAttribute('data-state', 'fast');
    await user.keyboard('{Escape}');
    await openFromRow(user);
    expect(screen.getByPlaceholderText('Message Codex…')).toHaveValue('Inspect this');
    expect(screen.getByText('notes.txt')).toBeInTheDocument();
    expect(speed()).toHaveAttribute('data-state', 'fast');
    await user.click(screen.getByPlaceholderText('Message Codex…'));
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByPlaceholderText('Message Codex…')).toHaveValue(''));
    const turns = requests('POST', `/api/claude-code-session/${TASK}/turns`);
    expect(turns).toHaveLength(2);
    expect((turns[1].body as Record<string, unknown>).client_message_id).toBe(
      (turns[0].body as Record<string, unknown>).client_message_id,
    );
    expect(turns[1].body).toMatchObject({
      attachments: [file],
      speed: 'fast',
    });
    expect(screen.queryByText('notes.txt')).toBeNull();
    // The delivery ACK's effective settings now drive the chip.
    await waitFor(() => expect(chip()).toHaveTextContent('codex/Test Codex Two'));
    expect(speed()).toHaveAttribute('data-state', 'fast');
  });

  it('keeps the composer intact below a native approval and resolves the exact request', async () => {
    serveBackend({
      ownerMessages: ownerChat([
        ...liveRows(),
        msg(
          {
            task_id: TASK,
            toolName: 'request_user_approval',
            toolCallId: 'native-approval-call',
            toolStatus: 'IN_PROGRESS',
            isUserAttentionMessage: true,
            requestingAgent: {
              kind: 'code_agent',
              task_id: TASK,
              agent_id: OWNER,
              label: 'Codex',
              provider: 'codex',
            },
            requestUserApproval: { toolApproval: true, attentionRequestId: 'native-approval-1' },
          },
          { text: 'Allow this command?' },
        ),
      ]),
    });
    server.use(
      http.post(`${API_BASE}/attention-requests/native-approval-1/respond`, () =>
        HttpResponse.json({ success: true }),
      ),
    );
    const user = await renderOnOwner();
    await openFromRow(user);
    const composer = screen.getByPlaceholderText('Message Codex…');
    await user.type(composer, 'Keep this draft');
    const accept = screen.getByRole('button', { name: 'Accept' });
    expect(
      accept.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await user.click(accept);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull());
    expect(composer).toHaveValue('Keep this draft');
    expect(requests('POST', '/api/attention-requests/native-approval-1/respond')).toHaveLength(1);
    expect(requests('POST', `/api/claude-code-session/${TASK}/turns`)).toHaveLength(0);
  });

  // The live counters are the running turn's metrics (codeSessionTurns WorkTurn.metrics):
  // the data the root transcript's thought row renders. No bespoke indicator exists.
  const streamTurn = (provider: 'claude' | 'codex', records: Array<Record<string, unknown>>) => {
    const messages = [chipMessage({ provider }), eventsMessage(records)];
    const turn = buildCodeSession({
      messages,
      taskId: TASK,
      ownerAgentId: OWNER,
      provider,
      sessionState: 'running',
      sessionEndedAt: null,
      echoes: [],
    }).find((entry) => entry.kind === 'work');
    if (turn?.kind !== 'work') throw new Error('no running turn');
    return turn.turn;
  };

  it.each(['claude', 'codex'] as const)(
    'derives real %s stream counters from its usage samples',
    (provider) => {
      const start = '2026-10-20T12:00:00.000Z';
      const scope = provider === 'claude' ? 'turn' : 'session';
      const turn = streamTurn(provider, [
        {
          id: 'native-start',
          type: 'turn',
          event: 'started',
          turn_id: 'native-stream',
          ts: start,
          turn_started_at: start,
        },
        {
          id: 'partial-answer',
          type: 'message',
          partial: true,
          turn_id: 'native-stream',
          ts: '2026-10-20T12:00:01.000Z',
          text: 'Live native answer',
        },
        {
          id: 'metric-1',
          type: 'metrics',
          turn_id: 'native-stream',
          usage_scope: scope,
          output_tokens: 100,
          ts: '2026-10-20T12:00:02.000Z',
        },
        {
          id: 'metric-2',
          type: 'metrics',
          turn_id: 'native-stream',
          usage_scope: scope,
          output_tokens: 120,
          ts: '2026-10-20T12:00:04.000Z',
        },
      ]);
      expect(turn.status).toBe('running');
      expect(turn.metrics?.outputTokens).toBe(provider === 'claude' ? 120 : 20);
      expect(turn.metrics?.tokensPerSecond).toBe(10);
      // The streaming answer is one row in the running turn's activities.
      expect(turn.activities.filter((m) => m.text === 'Live native answer')).toHaveLength(1);
    },
  );

  it('a resumed Codex stream has no invented zero counter or rate before its next native sample', () => {
    const turn = streamTurn('codex', [
      {
        id: 'start',
        type: 'turn',
        event: 'started',
        turn_id: 'resumed',
        ts: '2026-10-20T12:00:00.000Z',
      },
      {
        id: 'thinking',
        type: 'thinking',
        partial: true,
        text: 'Thinking about the task',
        turn_id: 'resumed',
        ts: '2026-10-20T12:00:01.000Z',
      },
      {
        id: 'metric',
        type: 'metrics',
        usage_scope: 'session',
        output_tokens: 12000,
        turn_id: 'resumed',
        ts: '2026-10-20T12:00:02.000Z',
      },
    ]);
    expect(turn.isThinking).toBe(true);
    expect(turn.metrics?.outputTokens).toBeUndefined();
    expect(turn.metrics?.tokensPerSecond).toBeUndefined();
  });
});
