/**
 * Blackbox (Andy 2026-11-08): a message to a STOPPED code agent resumes it
 * instead of failing, and the message shows the container coming back beside
 * its time.
 *
 *   ack       POST …/turns answering `queued` (resuming) is a successful send
 *   runs      the resumed run (same spawn tool call, new task id) joins the open
 *             code-agent view's conversation (mergeCodeAgentRuns)
 *   status    derived from the spawn's own rows after the message:
 *             none → "Resuming…" · next run's first row → "Starting container…"
 *             claude_code_started → "Delivered" · ERROR → "Couldn't resume: <text>"
 *   no dupe   the resumed CLI's own record of the same text never renders twice
 *   final     a message whose own resume failed stays failed when another
 *             message's later resume starts; one queued behind an open resume
 *             is carried to the next run and reads Delivered
 *   a11y      the status line is a live region (role="status")
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';

import { UserBubble } from '@/features/terminal-component-group/components/message-bubble/UserBubble';
import {
  mergeCodeAgentRuns,
  requestedByCodeAgent,
} from '@/features/terminal-component-group/hooks/codeAgentResume';
import { sendCodeAgentMessage } from '@/features/terminal-component-group/hooks/codeAgentContract';
import { codeSessionMessages } from '@/features/terminal-component-group/hooks/codeSessionMessages';
import type { Message } from '@/lib/api';

import { signIn } from './code-agent-steering.fixtures';
import { server } from './msw/server';

const API_BASE = 'http://localhost:3001/api';
const OLD = 'task-run-1';
const NEW = 'task-run-2';
const SPAWN = 'toolu_code_spawn';
const T0 = Date.UTC(2026, 10, 8, 12, 0, 0);
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

let seq = 0;
function row(metadata: Record<string, unknown>, text: string, s: number): Message {
  seq += 1;
  return {
    message_id: `m-${seq}`,
    timestamp: at(s),
    role: 'TOOL',
    text,
    metadata: { toolName: 'spawn_claude_code_agent', toolCallId: SPAWN, ...metadata },
  };
}

const firstRun = [
  row(
    { task_id: OLD, action_type: 'claude_code_started', toolStatus: 'IN_PROGRESS' },
    'Goal: x',
    0,
  ),
  row(
    { task_id: OLD, action_type: 'session_paused', toolStatus: 'FINISHED' },
    'Session idle; paused.',
    10,
  ),
];
const resumeTurn = row(
  {
    task_id: OLD,
    action_type: 'user_direct_turn',
    direct_turn_id: 'cm-resume-1',
    subAgentId: OLD,
    resume_requested: true,
    title: 'You',
  },
  'Also update the changelog.',
  20,
);
const nextRunStarting = row(
  { task_id: 'pending', toolStatus: 'IN_PROGRESS' },
  'Resuming code session',
  25,
);
const nextRunStarted = row(
  { task_id: NEW, action_type: 'claude_code_started', toolStatus: 'IN_PROGRESS' },
  'Goal: Also update the changelog.',
  40,
);
const resumedEcho = row(
  {
    task_id: NEW,
    action_type: 'code_transcript',
    isCodeTranscript: true,
    code_agent_events: [
      {
        id: 'u-1',
        rev: 1,
        seq: 1,
        provider: 'claude',
        ts: at(41),
        type: 'message',
        role: 'user',
        text: 'Also update the changelog.',
      },
      {
        id: 'a-1',
        rev: 1,
        seq: 2,
        provider: 'claude',
        ts: at(45),
        type: 'message',
        role: 'assistant',
        text: 'Updated CHANGELOG.md.',
      },
    ],
  },
  '',
  46,
);
const nextRunFailed = row(
  { task_id: 'pending', toolStatus: 'ERROR', title: 'Code session failed' },
  'Sandbox could not be resumed',
  30,
);

function viewMessages(owner: Message[]) {
  const { messages } = mergeCodeAgentRuns(owner, OLD);
  return codeSessionMessages({
    messages,
    taskId: OLD,
    ownerAgentId: 'root-1',
    provider: 'claude',
    sessionState: 'running',
    sessionEndedAt: null,
    echoes: [],
  });
}

function renderPerson(owner: Message[]) {
  const person = viewMessages(owner).filter(
    (message) => message.role === 'USER' && message.text === 'Also update the changelog.',
  );
  expect(person).toHaveLength(1);
  const view = render(<UserBubble message={person[0]} />);
  return { status: screen.getByTestId('code-agent-resume-status'), view };
}

describe('a message to a stopped code agent resumes it', () => {
  beforeEach(() => signIn());

  it('a `queued` (resuming) ack is a successful send', async () => {
    server.use(
      http.post(`${API_BASE}/claude-code-session/${OLD}/turns`, () =>
        HttpResponse.json({ status: 'queued', resuming: true, message_id: 'm-row', task_id: OLD }),
      ),
    );
    const ack = await sendCodeAgentMessage({ taskId: OLD, text: 'go on', clientMessageId: 'cm-1' });
    expect(ack.status).toBe('queued');
  });

  it('shows the container coming back beside the time: resuming → starting → delivered', () => {
    const resuming = renderPerson([...firstRun, resumeTurn]);
    expect(resuming.status).toHaveAttribute('data-resume-status', 'resuming');
    expect(resuming.status).toHaveTextContent(/^(?:.+, )?\d{1,2}:\d{2}.* · Resuming…$/);
    expect(resuming.status.querySelector('time')).toHaveAttribute('dateTime', at(20));
    resuming.view.unmount();

    const starting = renderPerson([...firstRun, resumeTurn, nextRunStarting]);
    expect(starting.status).toHaveTextContent('Starting container…');
    starting.view.unmount();

    const delivered = renderPerson([
      ...firstRun,
      resumeTurn,
      nextRunStarting,
      nextRunStarted,
      resumedEcho,
    ]);
    expect(delivered.status).toHaveAttribute('data-resume-status', 'delivered');
    expect(delivered.status).toHaveTextContent('Delivered');
    delivered.view.unmount();
  });

  it("a failed resume reads Couldn't resume with the backend's reason", () => {
    const failed = renderPerson([...firstRun, resumeTurn, nextRunFailed]);
    expect(failed.status).toHaveAttribute('data-resume-status', 'failed');
    expect(failed.status).toHaveTextContent("Couldn't resume: Sandbox could not be resumed");
  });

  it('the status line is a live region announced as it changes', () => {
    const { status } = renderPerson([...firstRun, resumeTurn, nextRunStarting]);
    expect(screen.getByRole('status')).toBe(status);
    expect(status).toHaveTextContent('Starting container…');
  });

  it("a message whose resume failed keeps Couldn't resume when a later message resumes", () => {
    const secondTurn = row(
      {
        task_id: OLD,
        action_type: 'user_direct_turn',
        direct_turn_id: 'cm-resume-2',
        subAgentId: OLD,
        resume_requested: true,
        title: 'You',
      },
      'Try again please.',
      35,
    );
    const owner = [...firstRun, resumeTurn, nextRunFailed, secondTurn, nextRunStarted];
    const rows = viewMessages(owner).filter((m) => m.role === 'USER');
    const states = Object.fromEntries(
      rows.map((m) => [m.text, (m.metadata?.codeAgentResume as { status?: string })?.status]),
    );
    expect(states['Also update the changelog.']).toBe('failed');
    expect(states['Try again please.']).toBe('delivered');
    const first = rows.find((m) => m.text === 'Also update the changelog.');
    render(<UserBubble message={first!} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      "Couldn't resume: Sandbox could not be resumed",
    );
  });

  it('a message queued behind an open resume is carried to the next run after it fails', () => {
    const queuedTurn = row(
      {
        task_id: OLD,
        action_type: 'user_direct_turn',
        direct_turn_id: 'cm-queued-2',
        subAgentId: OLD,
        resume_requested: true,
        title: 'You',
      },
      'And bump the version.',
      22,
    );
    const owner = [...firstRun, resumeTurn, queuedTurn, nextRunFailed, nextRunStarted];
    const states = Object.fromEntries(
      viewMessages(owner)
        .filter((m) => m.role === 'USER')
        .map((m) => [m.text, (m.metadata?.codeAgentResume as { status?: string })?.status]),
    );
    expect(states['Also update the changelog.']).toBe('failed');
    expect(states['And bump the version.']).toBe('delivered');
  });

  it('the resumed run joins the open view once, without a duplicate of the message', () => {
    const owner = [...firstRun, resumeTurn, nextRunStarting, nextRunStarted, resumedEcho];
    const runs = mergeCodeAgentRuns(owner, OLD);
    expect(runs.latestTaskId).toBe(NEW);
    const rows = viewMessages(owner);
    expect(rows.filter((m) => m.text === 'Also update the changelog.')).toHaveLength(1);
    expect(rows.some((m) => (m.text ?? '').includes('Updated CHANGELOG.md.'))).toBe(true);
  });

  it('a later message with the same text still renders (only the one echo is hidden)', () => {
    const again = row(
      {
        task_id: NEW,
        action_type: 'user_direct_turn',
        direct_turn_id: 'cm-again-2',
        subAgentId: NEW,
        title: 'You',
      },
      'Also update the changelog.',
      60,
    );
    const owner = [...firstRun, resumeTurn, nextRunStarting, nextRunStarted, resumedEcho, again];
    const people = viewMessages(owner).filter(
      (m) => m.role === 'USER' && m.text === 'Also update the changelog.',
    );
    expect(people).toHaveLength(2);
  });

  it("a resumed run's approval request counts for the open view", () => {
    const approval = (task: string, s: number) =>
      row(
        {
          task_id: task,
          toolName: 'request_user_approval',
          requestingAgent: {
            kind: 'code_agent',
            agent_id: 'root-1',
            provider: 'claude',
            task_id: task,
            label: 'Claude Code',
          },
        },
        'Approve pushing to main?',
        s,
      );
    const fromNewRun = approval(NEW, 50);
    const fromOther = approval('task-other', 51);
    const rows = requestedByCodeAgent([fromNewRun, fromOther], OLD, NEW);
    expect(rows).toEqual([fromNewRun]);
    expect(requestedByCodeAgent([fromNewRun], OLD, OLD)).toEqual([]);
  });

  it('a message to a running agent carries no resume line', () => {
    const plain = {
      ...resumeTurn,
      metadata: { ...resumeTurn.metadata, resume_requested: undefined },
    };
    const person = viewMessages([...firstRun, plain]).find(
      (m) => m.role === 'USER' && m.text === plain.text,
    );
    render(<UserBubble message={person!} />);
    expect(screen.queryByTestId('code-agent-resume-status')).toBeNull();
  });
});
