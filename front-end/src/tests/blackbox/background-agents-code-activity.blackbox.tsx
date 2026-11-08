/**
 * Blackbox: a code agent's row in the running-agents dock. Its activity line is
 * the start row's title ("Claude Code Started"), never the whole spawn goal the
 * start row carries, and long activity text stays on one CSS-truncated line.
 */
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderDock, row, started } from './background-agents.fixtures';

vi.mock('@/hooks/useAgentTree', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/hooks/useAgentTree');
  return { ...actual, useAgentTree: () => new Map() };
});
vi.mock('@/components/ThinkingAnimation', () => ({ default: () => <div /> }));

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function () {};
});

describe('running-agents dock: code agent activity', () => {
  it("a code agent's activity is its start title, never the spawn goal, on one truncated line", async () => {
    const goal = `You are working in the user's Rose app UI sandbox. ${'Remove the rose border. '.repeat(40)}`;
    renderDock([
      started('call_code', 'code', '/root/remove_rose_card_border', goal),
      row(
        {
          toolCallId: 'call_code',
          toolName: 'spawn_claude_code_agent',
          toolStatus: 'IN_PROGRESS',
          excludeFromModel: true,
          agentType: 'code',
          task_id: 't-code',
          title: 'Claude Code Started',
          action_type: 'claude_code_started',
        },
        `Goal: ${goal}`,
      ),
    ]);
    await userEvent.click(screen.getByRole('button', { name: /Running 1 agent/ }));
    const panel = screen.getByTestId('background-agents-panel');
    expect(panel).toHaveTextContent('code · remove_rose_card_border');
    expect(panel).not.toHaveTextContent('You are working in');
    const activity = within(panel).getByTestId('status-line-text');
    expect(activity).toHaveTextContent(/^Claude Code Started$/);
    expect(activity).toHaveClass('truncate', 'min-w-0');
  });
});
