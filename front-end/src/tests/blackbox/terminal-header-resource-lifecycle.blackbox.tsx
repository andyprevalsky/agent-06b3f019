import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TerminalHeaderSection } from '@/features/terminal/components/TerminalHeaderSection';
import type { TerminalLayoutProps } from '@/features/terminal/components/terminalLayoutState';

const captured = vi.hoisted(() => ({ callbacks: [] as (() => void)[] }));
vi.mock('@/features/terminal/components/TerminalHeader', () => ({
  TerminalHeader: ({ onLogout }: { onLogout: () => void }) => {
    captured.callbacks.push(onLogout);
    return (
      <div>
        <button onClick={onLogout}>Logout</button>
      </div>
    );
  },
}));

describe('terminal header action resource ownership', () => {
  it('keeps only the logout action when its originating full agent slice retires', () => {
    captured.callbacks = [];
    const logout = vi.fn(async () => {});
    const old = Proxy.revocable(
      {
        handleLogout: logout,
        messages: Array.from({ length: 10_000 }, (_, index) => ({ message_id: `old-${index}` })),
        selectedAgentId: 'old',
        agents: [],
        agentDetail: null,
      },
      {},
    );
    const drip = { dripStyles: {} } as TerminalLayoutProps['drip'];
    const { rerender } = render(
      <TerminalHeaderSection
        agents={old.proxy as unknown as TerminalLayoutProps['agents']}
        drip={drip}
      />,
    );
    const originalCallback = captured.callbacks.at(-1)!;
    rerender(
      <TerminalHeaderSection
        agents={
          {
            handleLogout: logout,
            messages: [],
            selectedAgentId: null,
            agents: [],
            agentDetail: null,
          } as unknown as TerminalLayoutProps['agents']
        }
        drip={drip}
      />,
    );
    old.revoke();
    expect(() => originalCallback()).not.toThrow();
    expect(logout).toHaveBeenCalledOnce();
    expect(captured.callbacks.at(-1)).toBe(originalCallback);
  });
});
