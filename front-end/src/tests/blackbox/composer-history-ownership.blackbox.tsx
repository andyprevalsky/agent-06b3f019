import { fireEvent, render, renderHook, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StrictMode, type ReactNode } from 'react';
import { AgentChatArea } from '@/features/terminal/components/AgentChatArea';
import { ComposerAgentProvider } from '@/features/terminal/components/ComposerAgentProvider';
import { useComposerActions } from '@/features/terminal/components/composerAgentContext';
import type { AgentSlice, DripSlice, Message } from '@/features/terminal/types';

vi.mock('@/hooks/roseDesktopContext', () => ({ useRoseDesktop: () => false }));
vi.mock('@/features/terminal/hooks/useOpeningAnimation', () => ({
  useOpeningAnimation: () => ({}),
}));
vi.mock('@/features/terminal/components/ChatScrollArea', () => ({ ChatScrollArea: () => null }));
vi.mock('@/features/terminal/components/TerminalLegalFooter', () => ({
  TerminalLegalFooter: () => null,
}));
vi.mock('@/features/terminal/components/GateStack', () => ({ GateStack: () => null }));
vi.mock('@/features/terminal-component-group', () => ({
  useAppView: () => null,
  useOpenCodeAgent: () => null,
  useCodeAgentView: () => null,
  PinnedQuestionMount: () => null,
  TaskCompletedBar: () => null,
  BackgroundAgentsBanner: ({ selectedAgentId }: { selectedAgentId: string | null }) => (
    <span data-testid="banner-owner">{selectedAgentId ?? 'home'}</span>
  ),
  QueryInput: ({ topAttachment, onSubmit }: { topAttachment: ReactNode; onSubmit: () => void }) => (
    <section>
      {topAttachment}
      <input aria-label="draft" defaultValue="" />
      <button onClick={onSubmit}>Send</button>
    </section>
  ),
}));

function reaches(root: unknown, target: unknown, seen = new Set<unknown>()): boolean {
  if (root === target) return true;
  if (!root || typeof root !== 'object' || seen.has(root)) return false;
  seen.add(root);
  return Object.entries(root).some(
    ([key, value]) =>
      key !== '_owner' && key !== '_store' && key !== 'ref' && reaches(value, target, seen),
  );
}

function hostRetains(container: HTMLElement, target: unknown): boolean {
  return [...container.querySelectorAll('*')].some((node) =>
    Object.entries(node).some(
      ([key, props]) => key.startsWith('__reactProps$') && reaches(props, target),
    ),
  );
}

function makeAgents(messages: Message[], owner: string | null, send = vi.fn()): AgentSlice {
  return {
    messages,
    selectedAgentId: owner,
    agentDetail: null,
    isChatMode: true,
    messageInput: '',
    selectedModel: 'rose-labs/rose-1-ultra',
    ancestors: [],
    handleSendMessage: send,
    setMessageInput: vi.fn(),
    setSelectedModel: vi.fn(),
    setFastMode: vi.fn(),
    setSimulatorMode: vi.fn(),
    setPendingPriceLimitCents: vi.fn(),
    handleSelectAgent: vi.fn(),
    refreshAgentDetail: vi.fn(),
    cleanupAgentState: vi.fn(),
    loadAgents: vi.fn(),
    handlePauseAgent: vi.fn(),
  } as unknown as AgentSlice;
}

function composer(agents: AgentSlice) {
  return (
    <AgentChatArea
      agents={agents}
      drip={{ dripStyles: {}, blur: 0 } as DripSlice}
      models={[]}
      modelsLoading={false}
      pendingApproval={null}
      pendingGates={[]}
      hasActiveAttentionRequest={false}
      browserStatusProps={null}
      systemMessages={[]}
      BrowserStatusBarCarousel={() => null}
    />
  );
}

describe('composer history ownership', () => {
  it('preserves the refresh origin of pending operations and retires actions after unmount in StrictMode', () => {
    const refresh = vi.fn();
    let agents = { ...makeAgents([], 'A'), refreshAgentDetail: refresh };
    const { result, rerender, unmount } = renderHook(useComposerActions, {
      wrapper: ({ children }) => (
        <StrictMode>
          <ComposerAgentProvider agents={agents}>{children}</ComposerAgentProvider>
        </StrictMode>
      ),
    });
    const original = result.current;
    agents = { ...makeAgents([], 'B'), refreshAgentDetail: refresh };
    rerender();
    original.onAgentUpdate();
    expect(refresh).toHaveBeenLastCalledWith('A');
    result.current.onAgentUpdate();
    expect(refresh).toHaveBeenLastCalledWith('B');
    unmount();
    refresh.mockClear();
    original.onAgentUpdate();
    original.onSubmit();
    expect(refresh).not.toHaveBeenCalled();
    expect(agents.handleSendMessage).not.toHaveBeenCalled();
  });
  it('releases closed history from persistent host props while preserving the input and current actions', () => {
    const history: Message[] = Array.from({ length: 50_000 }, (_, index) => ({
      message_id: `old-${index}`,
      timestamp: '2026-11-02T00:00:00Z',
      text: 'old history',
      role: 'ASSISTANT',
    }));
    const oldSend = vi.fn();
    const nextSend = vi.fn();
    const { container, rerender } = render(composer(makeAgents(history, 'old', oldSend)));
    const input = screen.getByLabelText('draft');
    fireEvent.change(input, { target: { value: 'keep my draft' } });
    input.focus();
    rerender(composer(makeAgents([], null, nextSend)));
    expect(screen.getByTestId('banner-owner').textContent).toBe('home');
    expect(screen.getByLabelText('draft')).toBe(input);
    expect(input).toHaveValue('keep my draft');
    expect(document.activeElement).toBe(input);
    fireEvent.click(screen.getByText('Send'));
    expect(nextSend).toHaveBeenCalledOnce();
    expect(oldSend).not.toHaveBeenCalled();
    expect(hostRetains(container, history)).toBe(false);
  });
});
