/**
 * Blackbox (Andy 2026-11-08): a person's message that resumed a stopped agent
 * shows its time and the resume state beneath it, from real rows only.
 *
 *   paused browser (Browser composer, backend `browserResume` + the spawn's
 *     toolCallId): Resuming… → Starting browser… (the resumed run's first row)
 *     → Delivered (it stepped) · an ERROR row → Couldn't resume: <reason>
 *   Rose agent (backend `resumedFrom`): Resuming… → Delivered (its next row)
 *   a message to a running agent: no resume line
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { AgentContext } from '@/features/agent-context';
import { UserBubble } from '@/features/terminal-component-group/components/message-bubble/UserBubble';
import type { Message } from '@/lib/api';

import { makeAgentCtx } from './message-bubble.fixtures';

const T0 = Date.UTC(2026, 10, 8, 13, 0, 0);
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

function row(
  role: Message['role'],
  text: string,
  s: number,
  metadata: Record<string, unknown> = {},
): Message {
  return { message_id: `m-${role}-${s}`, timestamp: at(s), role, text, metadata };
}

const browserTurn = row('USER', 'Use the second login.', 10, {
  browserTaskId: 'bs-1',
  excludeFromModel: true,
  browserResume: true,
  toolCallId: 'tc-browser',
});
const roseTurn = row('USER', 'Keep going.', 10, { resumedFrom: 'COMPLETED' });

function status(turn: Message, messages: Message[]) {
  const view = render(
    <AgentContext.Provider value={makeAgentCtx({ messages })}>
      <UserBubble message={turn} />
    </AgentContext.Provider>,
  );
  return { line: screen.queryByTestId('code-agent-resume-status'), view };
}

describe('resume state beside a resuming message', () => {
  it('paused browser: resuming → starting browser → delivered', () => {
    const before = row('TOOL', 'Clicked Continue', 1, {
      toolCallId: 'tc-browser',
      toolStatus: 'FINISHED',
    });
    const first = row('TOOL', 'Resuming the browser session', 12, {
      toolCallId: 'tc-browser',
      toolStatus: 'IN_PROGRESS',
    });
    const step = row('TOOL', 'Typing the second login', 15, {
      toolCallId: 'tc-browser:1',
      toolStatus: 'IN_PROGRESS',
    });

    const resuming = status(browserTurn, [before, browserTurn]);
    expect(resuming.line).toHaveAttribute('data-resume-status', 'resuming');
    expect(resuming.line).toHaveTextContent(/^\d{1,2}:\d{2}.* · Resuming…$/);
    expect(resuming.line?.querySelector('time')).toHaveAttribute('dateTime', at(10));
    resuming.view.unmount();

    const starting = status(browserTurn, [before, browserTurn, first]);
    expect(starting.line).toHaveTextContent('Starting browser…');
    starting.view.unmount();

    const delivered = status(browserTurn, [before, browserTurn, first, step]);
    expect(delivered.line).toHaveAttribute('data-resume-status', 'delivered');
    expect(delivered.line).toHaveTextContent('Delivered');
  });

  it("paused browser: an ERROR row reads Couldn't resume with its reason", () => {
    const refused = row('TOOL', 'its owner agent reached its cost limit', 11, {
      toolCallId: 'tc-browser',
      toolStatus: 'ERROR',
    });
    const { line } = status(browserTurn, [browserTurn, refused]);
    expect(line).toHaveAttribute('data-resume-status', 'failed');
    expect(line).toHaveTextContent("Couldn't resume: its owner agent reached its cost limit");
  });

  it('Rose agent: resuming → delivered at its next row', () => {
    const resuming = status(roseTurn, [roseTurn]);
    expect(resuming.line).toHaveTextContent('Resuming…');
    resuming.view.unmount();
    const reply = row('ASSISTANT', 'On it.', 13);
    const delivered = status(roseTurn, [roseTurn, reply]);
    expect(delivered.line).toHaveAttribute('data-resume-status', 'delivered');
  });

  it('a message to a running agent has no resume line', () => {
    const plain = row('USER', 'hi', 10);
    expect(status(plain, [plain]).line).toBeNull();
  });
});
