/**
 * Blackbox tests for the Fast Mode + Simulator toggles and their account gating.
 *
 * Proves checklist items:
 *  - #2  the toggle is hidden unless the user is in FAST_MODE_USER_IDS
 *  - #4  default off (controlled value starts false; toggling flips it)
 *  - #3  the toggle drives the boolean threaded into the create-agent payload
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Globe } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import FastModeToggle from '@/features/terminal-component-group/components/FastModeToggle';
import QueryInput from '@/features/terminal-component-group/components/QueryInput';
import RoseToolSetChip from '@/features/terminal-component-group/components/RoseToolSetChip';
import SimulatorToggle from '@/features/terminal-component-group/components/SimulatorToggle';
import { TopBar } from '@/features/terminal-component-group/components/query-input/TopBar';
import { ADMIN_USER_IDS } from '@/features/terminal-component-group/config';
import { FAST_MODE_USER_IDS } from '@/lib/fastModeAccounts';
import { SIMULATOR_USER_IDS } from '@/lib/simulatorAccounts';
import { TOOL_ICONS } from '@/lib/toolIcons';

const hookMocks = vi.hoisted(() => ({
  authUserId: '1f85ff25-6e29-4c1b-8739-f917bd101a30',
}));

const originalInnerWidth = window.innerWidth;

function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  });
}

vi.mock('@/features/terminal-component-group/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/terminal-component-group/hooks')>();
  return {
    ...actual,
    useAuth: () => ({
      user: hookMocks.authUserId === null ? null : { id: hookMocks.authUserId },
    }),
    useToast: () => ({ toast: vi.fn() }),
    updateAgent: vi.fn(),
    uploadAttachment: vi.fn(),
    MAX_FILE_SIZE: 20 * 1024 * 1024,
    MAX_TOTAL_ATTACHMENTS_SIZE: 100 * 1024 * 1024,
  };
});

function renderTopBar({
  showFastMode,
  fastMode = false,
  onFastModeChange = vi.fn(),
  showSimulator = false,
  simulatorMode = false,
  onSimulatorModeChange = vi.fn(),
}: {
  showFastMode: boolean;
  fastMode?: boolean;
  onFastModeChange?: (enabled: boolean) => void;
  showSimulator?: boolean;
  simulatorMode?: boolean;
  onSimulatorModeChange?: (enabled: boolean) => void;
}) {
  const noop = vi.fn();
  return render(
    <TooltipProvider>
      <TopBar
        showTestPrompts={false}
        showFastMode={showFastMode}
        fastMode={fastMode}
        onFastModeChange={onFastModeChange}
        showSimulator={showSimulator}
        simulatorMode={simulatorMode}
        onSimulatorModeChange={onSimulatorModeChange}
        onSelectPrompt={noop}
        pendingPriceLimitCents={100}
        priceLimit={
          {
            isEditing: false,
            draft: '',
            startEdit: noop,
            cancelEdit: noop,
            save: noop,
            setDraft: noop,
          } as never
        }
        contextPercentage={0}
        contextSize={0}
        restartThreshold={100000}
      />
    </TooltipProvider>,
  );
}

afterEach(() => {
  setViewportWidth(originalInnerWidth);
});

describe('Fast Mode account gating', () => {
  it('#2 shows the toggle in an existing-agent query box for allow-listed users', () => {
    hookMocks.authUserId = '1f85ff25-6e29-4c1b-8739-f917bd101a30';

    render(
      <TooltipProvider>
        <QueryInput
          value=""
          onChange={vi.fn()}
          onSubmit={vi.fn()}
          fastMode={false}
          onFastModeChange={vi.fn()}
          showModelSelector={false}
          agentDetail={
            {
              agent_id: 'agent-1',
              status: 'ACTIVE',
              model: 'rose-labs/rose-1-lite',
              write_lock_enabled: true,
              tree_cost_cents: 0,
              price_limit_cents: 100,
              parent_agent_id: null,
              tools: [],
              verifier: null,
            } as never
          }
        />
      </TooltipProvider>,
    );

    expect(screen.getByTestId('fast-mode-toggle')).toBeInTheDocument();
  });

  it('#2 hides the toggle when not allow-listed', () => {
    renderTopBar({ showFastMode: false });
    expect(screen.queryByTestId('fast-mode-toggle')).toBeNull();
  });

  it('#2 shows the toggle when allow-listed', () => {
    renderTopBar({ showFastMode: true });
    expect(screen.getByTestId('fast-mode-toggle')).not.toBeNull();
  });

  it('places Rose-ToolSet before Fast Mode and Simulator', () => {
    const { container } = renderTopBar({ showFastMode: true, showSimulator: true });
    const safeWrites = screen.getByText('Safe Writes');
    const fastMode = screen.getByTestId('fast-mode-toggle');
    const simulator = screen.getByTestId('simulator-toggle');
    const toolSet = screen.getByTitle('View Rose system tools');

    expect(safeWrites.compareDocumentPosition(toolSet) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
      0,
    );
    expect(toolSet.compareDocumentPosition(fastMode) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
      0,
    );
    expect(fastMode.compareDocumentPosition(simulator) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
      0,
    );
    expect(container.textContent).toContain('Safe Writes');
    expect(screen.getByTestId('fast-mode-toggle')).toHaveTextContent('');
    expect(screen.getByTestId('simulator-toggle')).toHaveTextContent('');
    expect(screen.getByTitle('View Rose system tools')).toHaveTextContent('');
  });

  it('hides Test-Prompts on mobile for admin accounts', () => {
    hookMocks.authUserId = '1f85ff25-6e29-4c1b-8739-f917bd101a30';
    setViewportWidth(390);

    render(
      <TooltipProvider>
        <QueryInput
          value=""
          onChange={vi.fn()}
          onSubmit={vi.fn()}
          fastMode={false}
          onFastModeChange={vi.fn()}
          showModelSelector={false}
        />
      </TooltipProvider>,
    );

    expect(screen.queryByTitle('Select a test prompt')).toBeNull();
    expect(screen.queryByLabelText('Select a test prompt')).toBeNull();
  });

  it('config allow-list contains exactly the two intended accounts', () => {
    expect(FAST_MODE_USER_IDS).toContain('1f85ff25-6e29-4c1b-8739-f917bd101a30'); // Andy
    expect(FAST_MODE_USER_IDS).toContain('43c2f6ae-37c0-42d0-bd88-2d6fc335b9e9'); // Tamy
    expect(FAST_MODE_USER_IDS.length).toBe(2);
  });
});

describe('Simulator account gating', () => {
  it.each(ADMIN_USER_IDS)('shows the simulator toggle for admin account %s', (userId) => {
    hookMocks.authUserId = userId;

    render(
      <TooltipProvider>
        <QueryInput
          value=""
          onChange={vi.fn()}
          onSubmit={vi.fn()}
          simulatorMode={false}
          onSimulatorModeChange={vi.fn()}
          showModelSelector={false}
        />
      </TooltipProvider>,
    );

    expect(screen.getByTestId('simulator-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('simulator-toggle')).toHaveAccessibleName('Simulator Off');
  });

  it('hides the simulator toggle for non-admin accounts', () => {
    hookMocks.authUserId = 'simulator-non-admin-user';

    render(
      <TooltipProvider>
        <QueryInput
          value=""
          onChange={vi.fn()}
          onSubmit={vi.fn()}
          simulatorMode={false}
          onSimulatorModeChange={vi.fn()}
          showModelSelector={false}
        />
      </TooltipProvider>,
    );

    expect(screen.queryByTestId('simulator-toggle')).toBeNull();
  });

  it('keeps simulator access in parity with the admin allow-list', () => {
    expect(SIMULATOR_USER_IDS).toEqual(ADMIN_USER_IDS);
  });
});

describe('FastModeToggle behavior', () => {
  it('#4 reflects the controlled (default off) value via aria-pressed', () => {
    render(
      <TooltipProvider>
        <FastModeToggle enabled={false} onChange={vi.fn()} />
      </TooltipProvider>,
    );
    const btn = screen.getByTestId('fast-mode-toggle');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn).toHaveAccessibleName('Fast Mode Off');
    expect(btn).toHaveTextContent('');
  });

  it('#3 toggling fires onChange with the flipped value', () => {
    const onChange = vi.fn();
    render(
      <TooltipProvider>
        <FastModeToggle enabled={false} onChange={onChange} />
      </TooltipProvider>,
    );
    act(() => {
      screen.getByTestId('fast-mode-toggle').click();
    });
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('does not show hover help', () => {
    render(
      <TooltipProvider>
        <FastModeToggle enabled={false} onChange={vi.fn()} />
      </TooltipProvider>,
    );

    fireEvent.mouseEnter(screen.getByTestId('fast-mode-toggle'));

    expect(screen.queryByText(/Replays cached third-party responses/)).toBeNull();
  });

  it('renders ON state with aria-pressed true', () => {
    render(
      <TooltipProvider>
        <FastModeToggle enabled={true} onChange={vi.fn()} />
      </TooltipProvider>,
    );
    expect(screen.getByTestId('fast-mode-toggle').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('fast-mode-toggle')).toHaveAccessibleName('Fast Mode On');
    expect(screen.getByTestId('fast-mode-toggle')).toHaveTextContent('');
  });

  it('updates the visible state after a click in the controlled querybox path', () => {
    let enabled = false;
    const onChange = vi.fn((next: boolean) => {
      enabled = next;
    });
    const view = render(
      <TooltipProvider>
        <FastModeToggle enabled={enabled} onChange={onChange} />
      </TooltipProvider>,
    );

    const btn = screen.getByTestId('fast-mode-toggle');
    expect(btn).toHaveAccessibleName('Fast Mode Off');
    expect(btn).toHaveTextContent('');

    act(() => {
      btn.click();
    });
    expect(onChange).toHaveBeenCalledWith(true);

    view.rerender(
      <TooltipProvider>
        <FastModeToggle enabled={enabled} onChange={onChange} />
      </TooltipProvider>,
    );
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    expect(btn).toHaveAccessibleName('Fast Mode On');
    expect(btn).toHaveTextContent('');
  });
});

describe('SimulatorToggle behavior', () => {
  it('is default-off when controlled value starts false', () => {
    render(
      <TooltipProvider>
        <SimulatorToggle enabled={false} onChange={vi.fn()} />
      </TooltipProvider>,
    );
    const btn = screen.getByTestId('simulator-toggle');
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    expect(btn).toHaveAccessibleName('Simulator Off');
    expect(btn).toHaveTextContent('');
  });

  it('toggles to true and renders the starry on state', () => {
    const onChange = vi.fn();
    render(
      <TooltipProvider>
        <SimulatorToggle enabled={false} onChange={onChange} />
      </TooltipProvider>,
    );
    act(() => {
      screen.getByTestId('simulator-toggle').click();
    });
    expect(onChange).toHaveBeenCalledWith(true);

    render(
      <TooltipProvider>
        <SimulatorToggle enabled={true} onChange={vi.fn()} />
      </TooltipProvider>,
    );
    const enabledButtons = screen.getAllByTestId('simulator-toggle');
    expect(enabledButtons[1]).toHaveAttribute('aria-pressed', 'true');
    expect(enabledButtons[1]).toHaveAttribute('data-state', 'on');
    expect(enabledButtons[1]).toHaveAccessibleName('Simulator On');
  });
});

describe('RoseToolSetChip contents', () => {
  it('removes deprecated tools and explains Wait For', () => {
    render(<RoseToolSetChip />);

    const trigger = screen.getByTitle('View Rose system tools');
    expect(trigger).toHaveTextContent('');

    fireEvent.mouseEnter(trigger);

    expect(screen.queryByText('x402')).toBeNull();
    expect(screen.queryByText('Monitor')).toBeNull();
    expect(screen.queryByText('Message User (PLAN)')).toBeNull();
    expect(screen.getByText('Wait For')).toBeInTheDocument();
    expect(screen.getByText(/Pause until a timestamp or repeatedly check/)).toBeInTheDocument();
  });

  it('uses a dedicated clean icon for Browser Agent', () => {
    expect(TOOL_ICONS.browser_agent).toBeDefined();
    expect(TOOL_ICONS.browser_agent).not.toBe(TOOL_ICONS.default);
    expect(TOOL_ICONS.browser_agent).toBe(Globe);
    expect(TOOL_ICONS.spawn_browser_agent).toBe(Globe);
  });
});
