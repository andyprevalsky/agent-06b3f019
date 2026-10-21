import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { AgentContext } from '@/features/agent-context';
import type { AgentContextValue } from '@/features/agent-context/types';
import { RoseAppsProvider } from '@/features/terminal-component-group';
import { RoseAppIcons } from '@/features/terminal-component-group/components/rose-apps/RoseAppIcons';
import { renderWithProviders } from './test-wrapper';

function scene(id: string | null, criteria: string | null, detailId = id) {
  const context = {
    agent: {
      agent_id: detailId,
      verifier: criteria === null ? null : { type: 'FLOAT_LLM_JUDGE', llm_judge_prompt: criteria },
    },
    isLoadingAgent: false,
  } as AgentContextValue;
  return (
    <AgentContext.Provider value={context}>
      <RoseAppsProvider selectedAgentId={id}>
        <RoseAppIcons />
      </RoseAppsProvider>
    </AgentContext.Provider>
  );
}
function hover(button: HTMLElement, pointerType = 'mouse') {
  const event = new Event('pointerover', { bubbles: true });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  fireEvent(button, event);
}
afterEach(() => vi.useRealTimers());

describe('Validation Criteria toolbar panel', () => {
  it('appears only on an agent and shows its real verifier, never another agent’s criteria', () => {
    const view = renderWithProviders(scene(null, null));
    expect(screen.queryByRole('button', { name: 'Validation Criteria' })).toBeNull();
    view.rerender(scene('a', 'Verify the build and keyboard controls.'));
    fireEvent.click(screen.getByRole('button', { name: 'Validation Criteria' }));
    expect(screen.getByTestId('validation-criteria-text')).toHaveTextContent(
      'Verify the build and keyboard controls.',
    );
    view.rerender(scene('b', 'Private criteria for a', 'a'));
    expect(screen.queryByText('Private criteria for a')).toBeNull();
    expect(screen.getByText('Loading validation criteria…')).toBeInTheDocument();
    view.rerender(scene('b', null));
    expect(
      screen.getByText('No validation criteria have been set for this agent.'),
    ).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByText('No validation criteria have been set for this agent.')).toBeNull();
  });

  it('opens on deliberate mouse hover, keeps the active panel open and supports click close', () => {
    vi.useFakeTimers();
    renderWithProviders(scene('a', 'Actual criteria'));
    const button = screen.getByRole('button', { name: 'Validation Criteria' });
    hover(button);
    act(() => vi.advanceTimersByTime(249));
    expect(screen.queryByTestId('validation-criteria-text')).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByTestId('validation-criteria-text')).toBeInTheDocument();
    hover(button);
    act(() => vi.advanceTimersByTime(250));
    expect(button).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-pressed', 'false');
    hover(button, 'touch');
    act(() => vi.advanceTimersByTime(500));
    expect(button).toHaveAttribute('aria-pressed', 'false');
  });

  it('cancels brief hovers and opens the other app panels without toggling theme', () => {
    vi.useFakeTimers();
    renderWithProviders(scene('a', 'Criteria'));
    const icons = screen.getByRole('navigation', { name: 'Apps' });
    const browser = within(icons).getByRole('button', { name: 'Browser' });
    hover(browser);
    fireEvent.pointerLeave(browser);
    act(() => vi.advanceTimersByTime(500));
    expect(browser).toHaveAttribute('aria-pressed', 'false');
    hover(browser);
    act(() => vi.advanceTimersByTime(250));
    expect(browser).toHaveAttribute('aria-pressed', 'true');
    const theme = within(icons).getByRole('button', { name: 'Dark mode' });
    hover(theme);
    act(() => vi.advanceTimersByTime(500));
    expect(theme).toHaveAttribute('aria-pressed', 'false');
  });
});
