import { createElement } from 'react';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ApprovalChip from '@/features/terminal-component-group/components/ApprovalChip';
import { MessageListItems } from '@/features/terminal-component-group/components/MessageListItems';
import type { Message } from '@/lib/api';
import { msg, WithAgent } from './code-agent-steering.fixtures';
import { renderWithProviders } from './test-wrapper';
const NOW = Date.parse('2026-10-21T12:00:00Z');
const party = (id: string, kind = 'agent') => ({ id, kind, label: id });
function exchange(
  id: string,
  o: {
    from?: string;
    to?: string;
    kind?: string;
    timestamp?: string;
    row?: string;
    codeOnly?: boolean;
  } = {},
) {
  return msg(
    {
      a2a: {
        message_id: id,
        from: party(o.from ?? 'root', o.codeOnly ? 'code' : 'agent'),
        to: party(o.to ?? 'worker', o.codeOnly ? 'code' : 'agent'),
        kind: o.kind ?? 'message',
        direction: 'received',
        text: `Private exchange ${id}`,
      },
    },
    {
      message_id: o.row ?? `row-${id}`,
      role: 'USER',
      timestamp: o.timestamp ?? new Date(NOW - 20000).toISOString(),
    },
  );
}
function projection(
  messages: Message[],
  o: { animate?: string; complete?: () => void; grouped?: boolean } = {},
) {
  return createElement(
    WithAgent,
    { messages, selectedAgentId: 'root' },
    createElement(MessageListItems, {
      filteredMessages: messages,
      ...{ groupAgentMessages: o.grouped ?? true },
      currentAnimatingId: o.animate ?? null,
      onAnimationComplete: o.complete ?? (() => {}),
      selectedAgentId: 'root',
      exploreStepMap: new Map(),
      waitForCheckMap: new Map(),
      streamingMetricsBySubAgentId: new Map(),
    }),
  );
}
const human = (id: string) => msg({}, { message_id: id, role: 'USER', text: `Human ${id}` });
afterEach(() => vi.useRealTimers());
describe('quiet agent coordination in a human turn', () => {
  it('folds 120 interleaved exchanges, deduplicates mirrors, bounds details and leaves human results visible', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const messages: Message[] = [human('start')];
    for (let i = 0; i < 120; i++) {
      messages.push(exchange(`${i}`));
      if (i % 10 === 0)
        messages.push(
          msg({ toolName: 'read_file', toolStatus: 'FINISHED' }, { text: `Work ${i}` }),
        );
      messages.push(exchange(`${i}`, { row: `mirror-${i}` }));
    }
    messages.push(
      msg(
        { toolName: 'send_message_to_user', isUserAttentionMessage: true },
        { text: 'Visible final result' },
      ),
    );
    renderWithProviders(projection(messages));
    const row = screen.getByTestId('agent-exchange-group');
    expect(row).toHaveTextContent('120 exchanges');
    expect(screen.queryByText('Private exchange 0')).toBeNull();
    expect(screen.getByText('Visible final result')).toBeInTheDocument();
    expect(screen.getByText('Human start')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: /Agents coordinating/ }));
    expect(within(row).getAllByTestId('a2a-row')).toHaveLength(20);
    expect(within(row).getAllByTestId('a2a-row')[0]).toHaveAttribute('data-a2a-direction', 'sent');
    fireEvent.click(within(row).getByRole('button', { name: 'Next exchanges' }));
    expect(within(row).getByText('Private exchange 20')).toBeInTheDocument();
    expect(within(row).queryByText('Private exchange 0')).toBeNull();
  });
  it('keeps expansion and anchor across replay and updates, and completes hidden typing rows once', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const complete = vi.fn();
    const first = exchange('a');
    const second = exchange('b', { from: 'worker', to: 'root' });
    const view = renderWithProviders(
      projection([first, second], { animate: second.message_id, complete }),
    );
    expect(complete).toHaveBeenCalledTimes(1);
    const row = screen.getByTestId('agent-exchange-group'),
      key = row.getAttribute('data-group-key');
    fireEvent.click(within(row).getByRole('button', { name: /Agents coordinating/ }));
    expect(within(row).getAllByTestId('a2a-row')[1]).toHaveAttribute(
      'data-a2a-direction',
      'received',
    );
    view.rerender(
      projection([exchange('a', { row: 'replayed-first' }), first, second, exchange('c')], {
        animate: second.message_id,
        complete,
      }),
    );
    expect(screen.getByTestId('agent-exchange-group')).toHaveAttribute('data-group-key', key);
    expect(within(row).getByRole('button', { name: /Agents coordinating/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(row).toHaveTextContent('3 exchanges');
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it('uses human turn boundaries; folds agent questions but keeps human questions and approvals visible', () => {
    const q = msg(
      { toolName: 'send_message_to_user', isUserAttentionMessage: true },
      { text: 'Which color do you want?' },
    );
    const approval = msg(
      {
        toolName: 'request_user_approval',
        toolStatus: 'IN_PROGRESS',
        requestUserApproval: { toolApproval: true, attentionRequestId: 'approval' },
      },
      { text: 'Please approve deployment' },
    );
    renderWithProviders(
      createElement(
        'div',
        null,
        projection([
          human('one'),
          exchange('question', { kind: 'question' }),
          q,
          approval,
          exchange('answer'),
          human('two'),
          exchange('new'),
        ]),
        createElement(ApprovalChip, {
          pendingApproval: { attentionRequestId: 'approval', question: approval.text },
        }),
      ),
    );
    expect(screen.getAllByTestId('agent-exchange-group')).toHaveLength(2);
    expect(screen.queryByText('Private exchange question')).toBeNull();
    expect(screen.getByText('Which color do you want?')).toBeInTheDocument();
    // ApprovalChip owns the visible control; the transcript must not add an empty spacer.
    expect(document.querySelector(`[data-message-id="${approval.message_id}"]`)).toBeNull();
    const approvalRow = screen.getByText('Please approve deployment');
    expect(approvalRow).toBeInTheDocument();
    expect(approvalRow.closest('[data-testid="agent-exchange-group"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
  });
  it('counts directed identities and leaves code-only exchanges untouched', () => {
    renderWithProviders(
      projection([
        exchange('same'),
        exchange('same', { from: 'worker', to: 'root', row: 'reverse' }),
        exchange('code', { codeOnly: true }),
      ]),
    );
    expect(screen.getByTestId('agent-exchange-group')).toHaveTextContent('2 exchanges');
    expect(screen.getByText('Private exchange code')).toBeInTheDocument();
  });
  it('ages observed activity without inventing rates from invalid or future timestamps', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const view = renderWithProviders(projection([exchange('recent')]));
    expect(screen.getByTestId('agent-exchange-group')).toHaveTextContent('1 in last minute');
    expect(screen.getByTestId('agent-exchange-group')).toHaveTextContent('last 20s ago');
    act(() => vi.advanceTimersByTime(60000));
    expect(screen.getByTestId('agent-exchange-group')).toHaveTextContent('0 in last minute');
    expect(screen.getByTestId('agent-exchange-group')).toHaveTextContent('last 1m ago');
    view.rerender(
      projection([
        exchange('invalid', { timestamp: 'invalid' }),
        exchange('future', { timestamp: new Date(NOW + 600000).toISOString() }),
      ]),
    );
    expect(screen.getByTestId('agent-exchange-group')).not.toHaveTextContent('in last minute');
    expect(screen.getByTestId('agent-exchange-group')).not.toHaveTextContent('ago');
  });
  it('preserves individual rows when disabled or outside normal GP lists', () => {
    const messages = [exchange('a')];
    const view = renderWithProviders(projection(messages, { grouped: false }));
    expect(screen.getByText('Private exchange a')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-exchange-group')).toBeNull();
    view.unmount();
    renderWithProviders(projection(messages), { roseDesktop: false });
    expect(screen.queryByTestId('agent-exchange-group')).toBeNull();
  });
});
