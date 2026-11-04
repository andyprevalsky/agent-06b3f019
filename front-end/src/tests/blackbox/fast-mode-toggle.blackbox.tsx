/**
 * Blackbox tests for the Fast Mode + Simulator toggles and their account gating.
 *
 * Proves checklist items:
 *  - #2  the toggle is hidden unless canUseFastMode(operator) is true
 *        (admin id, verified admin phone, or live impersonation)
 *  - #4  default on for allowlisted accounts (controlled value; toggling flips it)
 *  - #3  the toggle drives the boolean threaded into the create-agent payload
 *
 * Rose Desktop (UI ledger #32, #23): the speed square next to the model
 * selector cycles Normal -> Fast -> Ultrafast (default), Zap icon only at the
 * selector's 26px height; dark colors are toned down and scoped to html.dark.
 * The pinned simulator (#75) lives in rose-desktop-pinned-tools.blackbox.tsx.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryRouter } from 'react-router-dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { Globe } from 'lucide-react';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import FastModeToggle from '@/features/terminal-component-group/components/FastModeToggle';
import QueryInput from '@/features/terminal-component-group/components/QueryInput';
import RoseToolSetChip from '@/features/terminal-component-group/components/RoseToolSetChip';
import SimulatorToggle from '@/features/terminal-component-group/components/SimulatorToggle';
import { TopBar } from '@/features/terminal-component-group/components/query-input/TopBar';
import { ADMIN_USER_IDS } from '@/features/terminal-component-group/config';
import { ADMIN_ACCOUNTS, ADMIN_PHONE_DIGITS } from '@/lib/adminAccounts';
import { canUseFastMode, FAST_MODE_USER_IDS } from '@/lib/fastModeAccounts';
import { resetFastModeSessionOverride } from '@/lib/fastModeSession';
import { SIMULATOR_USER_IDS } from '@/lib/simulatorAccounts';
import { TOOL_ICONS } from '@/lib/toolIcons';
import { RoseDesktopContext } from '@/hooks/roseDesktopContext';
import { resetSpeedLevelSession } from '@/features/terminal-component-group/components/query-input/speedLevel';

const CURRENT_ANDY_ID = ADMIN_ACCOUNTS[0]!.userId;
const CURRENT_TAMY_ID = ADMIN_ACCOUNTS[1]!.userId;

const hookMocks = vi.hoisted(() => ({
  authUserId: '' as string | null,
  authUserPhone: '' as string,
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
      user:
        hookMocks.authUserId === null
          ? null
          : { id: hookMocks.authUserId, phone: hookMocks.authUserPhone },
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
        shouldAutoLoadDefaultPrompt={() => false}
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
  hookMocks.authUserPhone = '';
  resetFastModeSessionOverride();
  resetSpeedLevelSession();
});

describe('Fast Mode account gating', () => {
  beforeEach(() => {
    hookMocks.authUserId = CURRENT_ANDY_ID;
  });

  it('#2 shows the toggle in an existing-agent query box for allow-listed users', () => {
    hookMocks.authUserId = CURRENT_ANDY_ID;

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
              model: 'rose-labs/rose-1-flash',
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
    expect(screen.getByTestId('fast-mode-toggle')).toHaveAccessibleName('Fast Mode Off');
    expect(screen.getByTestId('fast-mode-toggle')).not.toHaveTextContent('Fast Mode');
    expect(screen.getByTestId('simulator-toggle')).toHaveTextContent('');
    expect(screen.getByTitle('View Rose system tools')).toHaveTextContent('');
  });

  it('hides Test-Prompts on mobile for admin accounts', () => {
    hookMocks.authUserId = CURRENT_ANDY_ID;
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

  it('#2 shows the toggle for a phone-matched admin whose user id is not allow-listed', () => {
    hookMocks.authUserId = 'not-an-allowlisted-admin-id';
    hookMocks.authUserPhone = '+19729777432';

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

    expect(screen.getByTestId('fast-mode-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('fast-mode-toggle')).toHaveAccessibleName('Fast Mode Off');
    expect(screen.getByTestId('fast-mode-toggle')).not.toHaveTextContent('Fast Mode');
    expect(canUseFastMode({ id: 'not-an-allowlisted-admin-id', phone: '+19729777432' })).toBe(true);
    expect(ADMIN_PHONE_DIGITS).toContain('19729777432');
  });

  it('#2 hides the toggle when id and phone are both non-admin', () => {
    hookMocks.authUserId = 'not-an-allowlisted-admin-id';
    hookMocks.authUserPhone = '+15555550100';

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

    expect(screen.queryByTestId('fast-mode-toggle')).toBeNull();
    expect(canUseFastMode({ id: 'not-an-allowlisted-admin-id', phone: '+15555550100' })).toBe(
      false,
    );
  });

  it.each(ADMIN_USER_IDS)('#2 shows the toggle for admin account %s', (userId) => {
    hookMocks.authUserId = userId;

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

    expect(screen.getByTestId('fast-mode-toggle')).toBeInTheDocument();
  });

  it('keeps Fast Mode access in parity with the admin allow-list', () => {
    expect(FAST_MODE_USER_IDS).toEqual(ADMIN_USER_IDS);
    expect(FAST_MODE_USER_IDS).toContain(CURRENT_ANDY_ID);
    expect(FAST_MODE_USER_IDS).toContain(CURRENT_TAMY_ID);
  });

  it('defaults Fast Mode on for every admin account', async () => {
    const { DEFAULT_FAST_MODE_USER_IDS } = await import('@/lib/fastModeAccounts');
    expect(DEFAULT_FAST_MODE_USER_IDS).toEqual(ADMIN_USER_IDS);
    expect(DEFAULT_FAST_MODE_USER_IDS).toContain(CURRENT_ANDY_ID);
    expect(DEFAULT_FAST_MODE_USER_IDS).toContain(CURRENT_TAMY_ID);
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
    expect(btn).not.toHaveTextContent('Fast Mode');
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
    expect(screen.getByTestId('fast-mode-toggle')).not.toHaveTextContent('Fast Mode');
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
    expect(btn).not.toHaveTextContent('Fast Mode');

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
    expect(btn).not.toHaveTextContent('Fast Mode');
  });

  it('query-box Fast Mode toggle is icon-only (no visible Fast Mode label)', () => {
    render(
      <TooltipProvider>
        <FastModeToggle enabled={true} onChange={vi.fn()} />
      </TooltipProvider>,
    );
    const btn = screen.getByTestId('fast-mode-toggle');
    expect(btn).toHaveAccessibleName('Fast Mode On');
    expect(btn).not.toHaveTextContent('Fast Mode');
    expect(btn.querySelector('svg')).not.toBeNull();
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

// ─── Rose Desktop speed toggle (#32, #23) ───────────────────────────────────

/** Controlled query box: the test re-renders with the value the toggle sent. */
function speedQueryBox(roseDesktop: boolean, fastMode: boolean, onFastModeChange = vi.fn()) {
  return (
    <MemoryRouter>
      <TooltipProvider>
        <RoseDesktopContext.Provider value={roseDesktop}>
          <QueryInput
            value=""
            onChange={vi.fn()}
            onSubmit={vi.fn()}
            selectedModel="rose-labs/rose-1-flash"
            fastMode={fastMode}
            onFastModeChange={onFastModeChange}
          />
        </RoseDesktopContext.Provider>
      </TooltipProvider>
    </MemoryRouter>
  );
}

const ROSE_QUERY_BOX_CSS = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    '../../features/terminal-component-group/components/query-input/roseQueryBox.css',
  ),
  'utf8',
);

function cssRules(css: string, needle: string): { selector: string; body: string }[] {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('}')
    .map((block) => {
      const [selector = '', body = ''] = block.split('{');
      return { selector: selector.trim(), body: body.trim() };
    })
    .filter((rule) => rule.selector.includes(needle));
}

describe('Rose Desktop speed toggle (#32, #23)', () => {
  beforeEach(() => {
    hookMocks.authUserId = CURRENT_ANDY_ID;
  });

  it('is a Zap-only 26px square right after the model selector, Fast by default', () => {
    render(speedQueryBox(true, true));
    const speed = screen.getByTestId('speed-toggle');
    expect(speed).toHaveAttribute('data-state', 'fast');
    expect(speed).toHaveAccessibleName('Fast');
    expect(speed.textContent).toBe('');
    expect(speed).toHaveClass('rose-speed', 'h-[26px]', 'w-[26px]', 'rounded-[8px]', 'border');
    // A rounded square (the mock's .mk-spd 8px corners), never the near-circle
    // rounded-lg (12px --radius) produced on a 26px box.
    expect(speed.className).not.toMatch(/(^|\s)rounded-(lg|xl|full|md)(\s|$)/);
    const zap = speed.querySelector('svg.lucide-zap')!;
    expect(zap).toHaveClass('h-[10.4px]', 'w-[10.4px]');
    expect(zap.getAttribute('fill')).toBe('currentColor');
    // Bottom row: model selector, then speed (the info button is gone).
    const model = screen.getByText('rose-flash').closest('button')!;
    expect(model.nextElementSibling).toBe(speed);
    expect(within(screen.getByTestId('query-input-surface')).getByTestId('speed-toggle')).toBe(
      speed,
    );
    // Not a second toggle on the tab.
    expect(screen.queryByTestId('fast-mode-toggle')).toBeNull();
    expect(
      within(screen.getByTestId('query-toolbar-nub')).queryByTestId('speed-toggle'),
    ).toBeNull();
  });

  it('cycles Fast -> Ultrafast -> Normal -> Fast; Ultrafast requires selection', () => {
    const onFastModeChange = vi.fn();
    const view = render(speedQueryBox(true, true, onFastModeChange));
    const speed = screen.getByTestId('speed-toggle');
    const clickAndApply = () => {
      fireEvent.click(speed);
      view.rerender(speedQueryBox(true, onFastModeChange.mock.lastCall![0], onFastModeChange));
    };

    clickAndApply();
    expect(onFastModeChange).toHaveBeenLastCalledWith(true);
    expect(speed).toHaveAttribute('data-state', 'ultra');
    expect(speed).toHaveAccessibleName('Ultrafast');

    clickAndApply();
    expect(onFastModeChange).toHaveBeenLastCalledWith(false);
    expect(speed).toHaveAttribute('data-state', 'normal');
    expect(speed).toHaveAccessibleName('Normal speed');
    expect(speed.querySelector('svg')!.getAttribute('fill')).toBe('none');

    clickAndApply();
    expect(onFastModeChange).toHaveBeenLastCalledWith(true);
    expect(speed).toHaveAttribute('data-state', 'fast');
    expect(speed).toHaveAccessibleName('Fast');
    expect(onFastModeChange).toHaveBeenCalledTimes(3);
  });

  it('shows Normal when Fast Mode is off and is hidden for accounts without Fast Mode', () => {
    const { unmount } = render(speedQueryBox(true, false));
    expect(screen.getByTestId('speed-toggle')).toHaveAttribute('data-state', 'normal');
    unmount();

    hookMocks.authUserId = 'not-an-allowlisted-admin-id';
    hookMocks.authUserPhone = '+15555550100';
    render(speedQueryBox(true, false));
    expect(screen.queryByTestId('speed-toggle')).toBeNull();
  });

  it('stock UI keeps the two-state Fast Mode toggle in the top row and no speed square', () => {
    render(speedQueryBox(false, true));
    expect(screen.queryByTestId('speed-toggle')).toBeNull();
    expect(screen.getByTestId('fast-mode-toggle')).toHaveAccessibleName('Fast Mode On');
  });

  it('colors follow the mock; every dark rule is toned down and scoped to html.dark', () => {
    const rules = cssRules(ROSE_QUERY_BOX_CSS, 'rose-speed');
    const body = (selector: string) => rules.find((r) => r.selector === selector)?.body ?? '';
    // Light: icy rose-blue (fast) and very icy with a glow (ultra).
    expect(body(".rose-speed[data-state='fast']")).toContain('color: #3a8fdc');
    expect(body(".rose-speed[data-state='ultra']")).toContain('color: #1f8ff0');
    expect(body(".rose-speed[data-state='ultra']")).toContain('0 0 14px rgba(125, 205, 255, 0.85)');
    // Dark: per the mock's dark.js, no glare.
    expect(body("html.dark .rose-speed[data-state='fast']")).toContain('color: #7fb8e6');
    expect(body("html.dark .rose-speed[data-state='ultra']")).toContain('color: #8fcfff');
    expect(body("html.dark .rose-speed[data-state='ultra'] svg")).toContain('filter: none');
    for (const { selector } of rules) {
      for (const part of selector.split(',')) {
        // Light rules key on the flag-only class; dark rules are html.dark-scoped.
        expect(part.trim()).toMatch(
          /^(html\.dark )?\.rose-speed\[data-state='(normal|fast|ultra)'\]/,
        );
      }
    }
    expect(rules.filter((r) => r.selector.startsWith('html.dark ')).length).toBe(4);
    // Shape is identical in both modes: no stylesheet rule changes the corners.
    for (const { body } of rules) expect(body).not.toMatch(/radius/);
  });
});
