/**
 * Blackbox: the root status line under the code-agent chips (Rose Desktop,
 * UI ledger row 44). Derived on the front-end from the spawn_claude_code_agent
 * rows (live vs. terminal) and any open pinned question; hidden when nothing is
 * running and absent with the flag off.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CodeAgentWaitStatus } from '@/features/terminal-component-group/components/CodeAgentWaitStatus';
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

const BASE = { base_branch: 'rose-ui/polish' };

/** A stock code-agent row with no `code_agent` snapshot (backend unchanged). */
function stockRow(taskId: string, actionType: string, extra: Record<string, unknown> = {}) {
  return msg({
    toolName: 'spawn_claude_code_agent',
    toolCallId: `call-${taskId}`,
    task_id: taskId,
    action_type: actionType,
    toolStatus: actionType === 'task_complete' ? 'FINISHED' : 'IN_PROGRESS',
    ...extra,
  });
}

function renderStatus(messages: Message[], roseDesktop = true) {
  return renderWithProviders(
    <WithAgent messages={messages}>
      <CodeAgentWaitStatus />
      <PinnedQuestionMount />
    </WithAgent>,
    { roseDesktop },
  );
}

const status = () => screen.queryByTestId('code-agent-wait-status');

beforeEach(() => {
  resetCodeAgentLocalState();
  fetchSession.mockClear();
  signIn();
});

describe('row 44: root status line under the chips', () => {
  it('one live code agent: "Rose is waiting on Codex, then merges <branch> into <base>"', () => {
    renderStatus([chipMessage(BASE)]);
    const line = screen.getByTestId('code-agent-wait-status');
    expect(line).toHaveTextContent(
      'Rose is waiting on Codex, then merges rose-ui/polish/speed into rose-ui/polish',
    );
    expect(line).toHaveAttribute('data-wait-kind', 'one');
    expect(line).toHaveClass('text-[13px]', 'text-muted-foreground');
    expect(line.querySelector('.animate-pulse.rounded-full')).not.toBeNull();
    expect(within(line).getByText('rose-ui/polish/speed').tagName).toBe('CODE');
  });

  it('derives "live" from stock rows when no code_agent snapshot exists', () => {
    renderStatus([stockRow('task-9', 'claude_code_started')]);
    expect(status()).toHaveTextContent(/^Rose is waiting on Claude Code$/);
  });

  it('several live code agents: "Rose is waiting on 2 code agents"', () => {
    renderStatus([
      chipMessage(BASE),
      stockRow('task-2', 'claude_code_started', { code_provider: 'codex' }),
    ]);
    expect(status()).toHaveTextContent(/^Rose is waiting on 2 code agents$/);
    expect(status()).toHaveAttribute('data-wait-kind', 'many');
  });

  it('completed, failed, cancelled or still spinning up → hidden', () => {
    const { unmount } = renderStatus([
      chipMessage(BASE),
      stockRow('task-1', 'task_complete', { success: true }),
    ]);
    expect(status()).toBeNull();
    unmount();

    const failed = renderStatus([chipMessage({ ...BASE, state: 'failed' })]);
    expect(status()).toBeNull();
    failed.unmount();

    // Handler cancel without task_id still ends the task sharing its toolCallId.
    const cancelled = renderStatus([
      stockRow('task-3', 'claude_code_started'),
      msg({
        toolName: 'spawn_claude_code_agent',
        toolCallId: 'call-task-3',
        action_type: 'session_cancelled',
      }),
    ]);
    expect(status()).toBeNull();
    cancelled.unmount();

    renderStatus([chipMessage({ ...BASE, state: 'spinning_up' })]);
    expect(status()).toBeNull();
  });

  it('an open pinned question: "Codex is waiting on your answer…", back to waiting on dismiss', async () => {
    renderStatus([chipMessage(BASE), questionMessage()]);
    expect(status()).toHaveTextContent(
      'Codex is waiting on your answer, then merges its branch into rose-ui/polish',
    );
    expect(status()).toHaveAttribute('data-wait-kind', 'answer');

    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss question' }));
    await waitFor(() =>
      expect(status()).toHaveTextContent(
        'Rose is waiting on Codex, then merges rose-ui/polish/speed into rose-ui/polish',
      ),
    );
  });

  it('a durably answered question no longer reads "waiting on your answer"', () => {
    renderStatus([chipMessage(BASE), questionMessage({}, { toolStatus: 'FINISHED' })]);
    expect(status()).toHaveAttribute('data-wait-kind', 'one');
  });

  it('flag off: absent', () => {
    renderStatus([chipMessage(BASE), questionMessage()], false);
    expect(status()).toBeNull();
  });

  it('mounts under the chips in the root view only', () => {
    const messages = [chipMessage(BASE)];
    const root = renderWithProviders(
      <WithAgent messages={messages}>
        <MessageList />
      </WithAgent>,
    );
    const line = screen.getByTestId('code-agent-wait-status');
    const chip = screen.getByTestId('code-agent-chip');
    expect(chip.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    root.unmount();

    renderWithProviders(
      <WithAgent messages={messages}>
        <MessageList subAgentId="task-1" />
      </WithAgent>,
    );
    expect(status()).toBeNull();
  });
});
