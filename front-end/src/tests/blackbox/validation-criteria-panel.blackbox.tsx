import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { AgentContext } from '@/features/agent-context';
import type { AgentContextValue } from '@/features/agent-context/types';
import { RoseAppsProvider } from '@/features/terminal-component-group';
import { useRoseApps } from '@/features/terminal-component-group/components/rose-apps/roseAppsState';
import { RoseAppIcons } from '@/features/terminal-component-group/components/rose-apps/RoseAppIcons';
import { renderWithProviders } from './test-wrapper';

function CriteriaOpener() {
  const apps = useRoseApps();
  return <button onClick={() => apps?.toggleApp('validation')}>Open criteria for test</button>;
}

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
        <CriteriaOpener />
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
  it('keeps the icon absent and preserves real verifier ownership when opened programmatically', () => {
    const view = renderWithProviders(scene(null, null));
    expect(screen.queryByRole('button', { name: 'Validation Criteria' })).toBeNull();
    view.rerender(scene('a', 'Verify the build and keyboard controls.'));
    expect(screen.queryByRole('button', { name: 'Validation Criteria' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open criteria for test' }));
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

  it('keeps the same five app controls on Home and selected agents', () => {
    const view = renderWithProviders(scene(null, null));
    const labels = () =>
      within(screen.getByRole('navigation', { name: 'Apps' }))
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label'));
    const expected = ['Agent Display', 'Browser', 'Phone', 'Integrations', 'Dark mode'];
    expect(labels()).toEqual(expected);
    view.rerender(scene('a', 'Actual criteria'));
    expect(labels()).toEqual(expected);
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
