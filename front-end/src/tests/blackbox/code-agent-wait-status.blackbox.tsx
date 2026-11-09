/**
 * Blackbox: the root view has no "Rose is waiting on <agent>, then merges
 * <branch> into <base>" status line under the code-agent chips (Rose Desktop).
 * The line was removed (2026-11-08): it promised a merge that Rose never
 * performs, and the live code-agent row already shows what is running.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

import { MessageList } from '@/features/terminal-component-group/components/MessageList';
import { PinnedQuestionMount } from '@/features/terminal-component-group/components/PinnedQuestion';
import { resetCodeAgentLocalState } from '@/features/terminal-component-group/hooks/codeAgentLocalState';
import type { Message } from '@/lib/api';

import { renderWithProviders } from './test-wrapper';
import {
  WithAgent,
  chipMessage,
  msg,
  questionMessage,
  signIn,
} from './code-agent-steering.fixtures';

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

const BASE = { base_branch: 'main' };

function renderRoot(messages: Message[]) {
  return renderWithProviders(
    <WithAgent messages={messages}>
      <MessageList />
      <PinnedQuestionMount />
    </WithAgent>,
    { roseDesktop: true },
  );
}

function expectNoWaitLine() {
  expect(screen.queryByTestId('code-agent-wait-status')).toBeNull();
  expect(
    screen.queryByText(/waiting on (Claude Code|Codex|your answer|\d+ code agents)/),
  ).toBeNull();
  expect(screen.queryByText(/then merges/)).toBeNull();
}

beforeEach(() => {
  resetCodeAgentLocalState();
  fetchSession.mockClear();
  signIn();
});

describe('root view: no code-agent wait/merge status line', () => {
  it('one live code agent with a branch and merge target', () => {
    renderRoot([chipMessage(BASE)]);
    expect(screen.getByTestId('trajectory-work-group')).toBeInTheDocument();
    expectNoWaitLine();
  });

  it('several live code agents', () => {
    renderRoot([
      chipMessage(BASE),
      msg({
        toolName: 'spawn_claude_code_agent',
        toolCallId: 'call-task-2',
        task_id: 'task-2',
        action_type: 'claude_code_started',
        toolStatus: 'IN_PROGRESS',
        code_provider: 'codex',
      }),
    ]);
    expectNoWaitLine();
  });

  it('a code agent with an open pinned question', () => {
    renderRoot([chipMessage(BASE), questionMessage()]);
    expectNoWaitLine();
  });
});
