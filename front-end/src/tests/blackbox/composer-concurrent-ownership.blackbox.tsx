import { act, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode, Suspense, startTransition, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ComposerAgentProvider } from '@/features/terminal/components/ComposerAgentProvider';
import {
  useComposerAgent,
  useComposerActions,
} from '@/features/terminal/components/composerAgentContext';
import type { AgentSlice } from '@/features/terminal/types';

function agent(id: string) {
  return {
    selectedAgentId: id,
    messageInput: `draft-${id}`,
    selectedModel: `model-${id}`,
    messages: [],
    handleSendMessage: vi.fn(),
    setMessageInput: vi.fn(),
    handlePauseAgent: vi.fn(),
    refreshAgentDetail: vi.fn(),
    handleSelectAgent: vi.fn(),
    setSelectedModel: vi.fn(),
    setFastMode: vi.fn(),
    setSimulatorMode: vi.fn(),
    setPendingPriceLimitCents: vi.fn(),
    cleanupAgentState: vi.fn(),
    loadAgents: vi.fn(),
  } as unknown as AgentSlice;
}

describe('composer concurrent committed ownership', () => {
  function Composer() {
    const a = useComposerAgent();
    const actions = useComposerActions();
    return (
      <>
        <span data-testid="owner">
          {a.selectedAgentId}:{a.messageInput}:{a.selectedModel}
        </span>
        <input
          aria-label="draft"
          value={a.messageInput}
          onChange={(event) => actions.onChange(event.target.value)}
        />
        <button onClick={() => actions.onSubmit()}>Send</button>
        <button onClick={actions.onPause}>Pause</button>
        <button onClick={actions.onAgentUpdate}>Refresh</button>
      </>
    );
  }

  it.each([false, true])(
    'routes the still-visible A composer to A while a B transition suspends (StrictMode=%s)',
    (strict) => {
      const a = agent('A');
      const b = agent('B');
      const never = new Promise<void>(() => {});
      let select: (next: AgentSlice) => void = () => {};
      function Boundary({ selected }: { selected: AgentSlice }) {
        if (selected === b) throw never;
        return null;
      }
      function Harness() {
        const [selected, setSelected] = useState(a);
        select = setSelected;
        return (
          <Suspense fallback={<p>Waiting for B</p>}>
            <ComposerAgentProvider agents={selected}>
              <Composer />
              <Boundary selected={selected} />
            </ComposerAgentProvider>
          </Suspense>
        );
      }
      const view = strict ? (
        <StrictMode>
          <Harness />
        </StrictMode>
      ) : (
        <Harness />
      );
      const { unmount } = render(view);
      const input = screen.getByLabelText('draft');
      act(() => startTransition(() => select(b)));
      expect(screen.getByTestId('owner')).toHaveTextContent('A:draft-A:model-A');
      expect(screen.queryByText('Waiting for B')).toBeNull();
      expect(screen.getByLabelText('draft')).toBe(input);
      fireEvent.click(screen.getByText('Send'));
      fireEvent.change(input, { target: { value: 'still editing A' } });
      fireEvent.click(screen.getByText('Pause'));
      expect({
        A: {
          sent: vi.mocked(a.handleSendMessage).mock.calls.length,
          edits: vi.mocked(a.setMessageInput).mock.calls,
          paused: vi.mocked(a.handlePauseAgent).mock.calls.length,
        },
        B: {
          sent: vi.mocked(b.handleSendMessage).mock.calls.length,
          edits: vi.mocked(b.setMessageInput).mock.calls,
          paused: vi.mocked(b.handlePauseAgent).mock.calls.length,
        },
      }).toEqual({
        A: { sent: 1, edits: [['still editing A']], paused: 1 },
        B: { sent: 0, edits: [], paused: 0 },
      });
      unmount();
    },
  );

  it('renders the newly committed agent immediately and preserves scalar-bound refresh origins', () => {
    const a = agent('A');
    const b = agent('B');
    let selected = a;
    let original: ReturnType<typeof useComposerActions> | undefined;
    function Probe() {
      const actions = useComposerActions();
      original ??= actions;
      return <Composer />;
    }
    function Harness() {
      return (
        <ComposerAgentProvider agents={selected}>
          <Probe />
        </ComposerAgentProvider>
      );
    }
    const { rerender, unmount } = render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );
    const input = screen.getByLabelText('draft');
    selected = b;
    rerender(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );
    expect(screen.getByTestId('owner')).toHaveTextContent('B:draft-B:model-B');
    expect(screen.getByLabelText('draft')).toBe(input);
    fireEvent.click(screen.getByText('Send'));
    fireEvent.click(screen.getByText('Refresh'));
    expect(b.handleSendMessage).toHaveBeenCalledOnce();
    expect(b.refreshAgentDetail).toHaveBeenCalledWith('B');
    original!.onAgentUpdate();
    expect(b.refreshAgentDetail).toHaveBeenLastCalledWith('A');
    unmount();
    original!.onSubmit();
    expect(b.handleSendMessage).toHaveBeenCalledOnce();
  });
});
