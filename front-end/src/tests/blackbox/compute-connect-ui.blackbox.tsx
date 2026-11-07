import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import ComputeSection from '@/features/integrations/components/ComputeSection';
import { ComputeConnectModal } from '@/features/integrations/components/ComputeAccountsSection';
import type { useComputeAccounts as UseComputeAccounts } from '@/features/integrations/hooks/useComputeAccounts';

vi.mock('@/features/integrations/hooks/useComputeAccounts', () => ({
  useComputeAccounts: (provider: string) => ({
    accounts:
      provider === 'codex'
        ? [
            {
              provider: 'codex',
              accountId: 'chatgpt-account-123',
              accountEmail: 'a@roselabs.ai',
              state: 'connected',
              lastErrorReason: null,
            },
          ]
        : [],
    phase: 'idle',
    error: null,
    liveViewUrl: null,
    stage: null,
    connectingAs: null,
    passkeyUnavailableFor: null,
    runId: 0,
    removing: null,
    connect: vi.fn(),
    cancel: vi.fn(),
    remove: vi.fn(),
    isConnecting: false,
  }),
}));

describe('compute connection UI', () => {
  it('wraps ChatGPT account chips onto their own lane', () => {
    render(
      <ComputeSection
        expanded={true}
        onToggle={() => {}}
        isClaudeCodeAvailable={true}
        isGptCodeAvailable={true}
        claudeCodeSynced={false}
        gptCodeSynced={true}
        claudeCodeSyncLoading={false}
        gptCodeSyncLoading={false}
        claudeCodeStatus={null}
        onClaudeCodeSync={() => {}}
        onGptCodeSync={() => {}}
      />,
    );

    const row = screen.getByText('ChatGPT Subscription').closest('.border-b');
    expect(row).toHaveClass('flex-wrap');
    expect(screen.getByText('a@roselabs.ai').closest('.w-full')).toBeInTheDocument();
  });

  it('covers the remote browser once a callback is being captured', () => {
    const state = {
      accounts: [],
      phase: 'signing_in',
      error: null,
      liveViewUrl: 'https://browser.example/live',
      stage: 'capturing',
      connectingAs: 'a@roselabs.ai',
      passkeyUnavailableFor: null,
      runId: 1,
      removing: null,
      connect: vi.fn(),
      cancel: vi.fn(),
      remove: vi.fn(),
      isConnecting: true,
    } as unknown as ReturnType<typeof UseComputeAccounts>;

    render(<ComputeConnectModal state={state} providerLabel="ChatGPT" />);

    expect(screen.getByTestId('compute-connect-finishing')).toBeInTheDocument();
    expect(screen.queryByTitle('Sign in to ChatGPT')).not.toBeInTheDocument();
    expect(screen.getByText('Finishing connection…')).toBeInTheDocument();
  });

  it('explains a passkey prompt Rose cannot answer instead of leaving a dead button', () => {
    const base = {
      accounts: [],
      phase: 'signing_in',
      error: null,
      liveViewUrl: 'https://browser.example/live',
      stage: 'awaiting_human',
      connectingAs: null,
      runId: 1,
      removing: null,
      connect: vi.fn(),
      cancel: vi.fn(),
      remove: vi.fn(),
      isConnecting: true,
    };
    const { rerender } = render(
      <ComputeConnectModal
        state={
          { ...base, passkeyUnavailableFor: null } as unknown as ReturnType<
            typeof UseComputeAccounts
          >
        }
        providerLabel="ChatGPT"
      />,
    );
    expect(screen.queryByTestId('compute-connect-passkey-unavailable')).not.toBeInTheDocument();

    rerender(
      <ComputeConnectModal
        state={
          { ...base, passkeyUnavailableFor: 'openai.com' } as unknown as ReturnType<
            typeof UseComputeAccounts
          >
        }
        providerLabel="ChatGPT"
      />,
    );
    const notice = screen.getByTestId('compute-connect-passkey-unavailable');
    expect(notice).toHaveTextContent("Rose doesn't have your openai.com passkey");
    expect(notice).toHaveTextContent('Pick another verification method in the window above');
    expect(screen.getByTitle('Sign in to ChatGPT')).toBeInTheDocument();
  });
});
