/** Browser task steps remain individual rows; only the main trajectory compresses. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { AgentContext } from '@/features/agent-context';
import { MessageList } from '@/features/terminal-component-group/components/MessageList';
import { makeCtx } from './browser-agent-chip.fixtures';
import { msg } from './code-agent-steering.fixtures';
import { renderWithProviders } from './test-wrapper';

const scrollIntoView = HTMLElement.prototype.scrollIntoView;
beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
});

it('renders each Browser task step without a compressed work or exchange row', () => {
  const messages = ['first-step', 'second-step'].map((id) =>
    msg(
      { toolName: 'read_file', toolCallId: id, subAgentId: 'browser-task', toolStatus: 'FINISHED' },
      { message_id: id, text: id },
    ),
  );
  renderWithProviders(
    <AgentContext.Provider value={makeCtx(messages)}>
      <MessageList subAgentId="browser-task" showThinkingIndicator={false} />
    </AgentContext.Provider>,
  );
  expect(screen.queryByTestId('trajectory-work-group')).toBeNull();
  expect(screen.queryByTestId('agent-exchange-group')).toBeNull();
  expect(document.querySelector('[data-message-id="first-step"]')).not.toBeNull();
  expect(document.querySelector('[data-message-id="second-step"]')).not.toBeNull();
});

it('retains compression in the main trajectory', () => {
  const messages = ['first-root-step', 'second-root-step'].map((id) =>
    msg(
      { toolName: 'read_file', toolCallId: id, toolStatus: 'FINISHED' },
      { message_id: id, text: id },
    ),
  );
  renderWithProviders(
    <AgentContext.Provider value={makeCtx(messages)}>
      <MessageList showThinkingIndicator={false} />
    </AgentContext.Provider>,
  );
  expect(screen.getAllByTestId('trajectory-work-group')).toHaveLength(1);
  expect(screen.queryByTestId('trajectory-work-history')).toBeNull();
});
