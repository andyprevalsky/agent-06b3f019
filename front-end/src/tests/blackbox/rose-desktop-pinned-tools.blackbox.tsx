/**
 * Blackbox tests for the Rose Desktop query box's pinned controls (UI ledger
 * row 75): the world simulator (admin only) stays pinned top-left inside the
 * box right after the Rose toolset chip, with its exact stock styling, and
 * both controls look identical in light and dark mode. Never on the nub tab.
 * The toolset chip's own placement/styling: rose-desktop-flag.blackbox.tsx.
 */
import { MemoryRouter } from 'react-router-dom';
import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import QueryInput from '@/features/terminal-component-group/components/QueryInput';
import { ADMIN_USER_IDS } from '@/features/terminal-component-group/config';
import { ADMIN_ACCOUNTS } from '@/lib/adminAccounts';
import { SIMULATOR_USER_IDS } from '@/lib/simulatorAccounts';
import { RoseDesktopContext } from '@/hooks/roseDesktopContext';

const CURRENT_ANDY_ID = ADMIN_ACCOUNTS[0]!.userId;

const hookMocks = vi.hoisted(() => ({ authUserId: '' as string }));

vi.mock('@/features/terminal-component-group/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/terminal-component-group/hooks')>();
  return {
    ...actual,
    useAuth: () => ({ user: { id: hookMocks.authUserId, phone: '' } }),
    useToast: () => ({ toast: vi.fn() }),
    updateAgent: vi.fn(),
    uploadAttachment: vi.fn(),
    MAX_FILE_SIZE: 20 * 1024 * 1024,
    MAX_TOTAL_ATTACHMENTS_SIZE: 100 * 1024 * 1024,
  };
});

it('every admin is a simulator account (the cases below cover them all)', () => {
  expect([...SIMULATOR_USER_IDS].sort()).toEqual([...ADMIN_USER_IDS].sort());
});

// ─── Rose Desktop pinned simulator (#75) ────────────────────────────────────

function simulatorQueryBox(roseDesktop: boolean, simulatorMode: boolean) {
  return (
    <MemoryRouter>
      <TooltipProvider>
        <RoseDesktopContext.Provider value={roseDesktop}>
          <QueryInput
            value=""
            onChange={vi.fn()}
            onSubmit={vi.fn()}
            simulatorMode={simulatorMode}
            onSimulatorModeChange={vi.fn()}
            showModelSelector={false}
          />
        </RoseDesktopContext.Provider>
      </TooltipProvider>
    </MemoryRouter>
  );
}

describe('Rose Desktop pinned simulator (#75)', () => {
  afterEach(() => document.documentElement.classList.remove('dark'));

  it.each(ADMIN_USER_IDS)(
    'admin %s: the simulator sits right after the toolset chip inside the box',
    (userId) => {
      hookMocks.authUserId = userId;
      render(simulatorQueryBox(true, false));
      const row = screen.getByTestId('query-pinned-tools');
      const sim = within(row).getByTestId('simulator-toggle');
      expect(
        within(screen.getByTestId('query-input-surface')).getByTestId('simulator-toggle'),
      ).toBe(sim);
      expect(screen.getByTestId('pinned-toolset-chip').nextElementSibling).toBe(sim);
      expect(
        within(screen.getByTestId('query-toolbar-nub')).queryByTestId('simulator-toggle'),
      ).toBeNull();
      // Exact stock toggle (same as the flag-off row).
      expect(sim).toHaveAccessibleName('Simulator Off');
      expect(sim).toHaveClass(
        'h-7',
        'w-7',
        'rounded-md',
        'border-indigo-950/20',
        'text-indigo-200/75',
      );
      expect(sim.className).toContain(
        'bg-[linear-gradient(135deg,#111827_0%,#1e1b4b_58%,#312e81_100%)]',
      );
    },
  );

  it('is hidden for non-admin accounts', () => {
    hookMocks.authUserId = 'simulator-non-admin-user';
    render(simulatorQueryBox(true, false));
    expect(screen.getByTestId('pinned-toolset-chip')).toBeInTheDocument();
    expect(screen.queryByTestId('simulator-toggle')).toBeNull();
  });

  it.each([false, true])('looks identical in dark mode (simulator on: %s)', (simulatorMode) => {
    hookMocks.authUserId = CURRENT_ANDY_ID;
    const light = render(simulatorQueryBox(true, simulatorMode));
    const lightClasses = [
      screen.getByTestId('simulator-toggle').className,
      screen.getByTestId('pinned-toolset-chip').className,
    ];
    light.unmount();
    document.documentElement.classList.add('dark');
    render(simulatorQueryBox(true, simulatorMode));
    const darkClasses = [
      screen.getByTestId('simulator-toggle').className,
      screen.getByTestId('pinned-toolset-chip').className,
    ];
    expect(darkClasses).toEqual(lightClasses);
    for (const className of darkClasses) {
      expect(className).not.toMatch(/(^|\s)dark:/);
      expect(className).not.toMatch(/(^|\s)\S*-(border|background|foreground|muted)(\s|$)/);
    }
  });
});
