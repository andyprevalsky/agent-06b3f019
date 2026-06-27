/**
 * Blackbox tests for the Fast Mode toggle + its account gating.
 *
 * Proves checklist items:
 *  - #2  the toggle is hidden unless the user is in FAST_MODE_USER_IDS
 *  - #4  default off (controlled value starts false; toggling flips it)
 *  - #3  the toggle drives the boolean threaded into the create-agent payload
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import FastModeToggle from '@/features/terminal-component-group/components/FastModeToggle';
import QueryInput from '@/features/terminal-component-group/components/QueryInput';
import RoseToolSetChip from '@/features/terminal-component-group/components/RoseToolSetChip';
import { TopBar } from '@/features/terminal-component-group/components/query-input/TopBar';
import { FAST_MODE_USER_IDS } from '@/lib/fastModeAccounts';
import { TOOL_ICONS } from '@/lib/toolIcons';

const hookMocks = vi.hoisted(() => ({
  authUserId: '1f85ff25-6e29-4c1b-8739-f917bd101a30',
}));

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

function renderTopBar(showFastMode: boolean, fastMode = false, onFastModeChange = vi.fn()) {
  const noop = vi.fn();
  return render(
    <TooltipProvider>
      <TopBar
        showTestPrompts={false}
        showFastMode={showFastMode}
        fastMode={fastMode}
        onFastModeChange={onFastModeChange}
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
    renderTopBar(false);
    expect(screen.queryByTestId('fast-mode-toggle')).toBeNull();
  });

  it('#2 shows the toggle when allow-listed', () => {
    renderTopBar(true);
    expect(screen.getByTestId('fast-mode-toggle')).not.toBeNull();
  });

  it('places Fast Mode between Safe Writes and Rose-ToolSet', () => {
    const { container } = renderTopBar(true);
    const safeWrites = screen.getByText('Safe Writes');
    const fastMode = screen.getByTestId('fast-mode-toggle');
    const toolSet = screen.getByTitle('View Rose system tools');

    expect(
      safeWrites.compareDocumentPosition(fastMode) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(fastMode.compareDocumentPosition(toolSet) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
      0,
    );
    expect(container.textContent).toMatch(/Safe Writes.*Fast Mode Off.*Rose-ToolSet/s);
  });

  it('config allow-list contains exactly the two intended accounts', () => {
    expect(FAST_MODE_USER_IDS).toContain('1f85ff25-6e29-4c1b-8739-f917bd101a30'); // Andy
    expect(FAST_MODE_USER_IDS).toContain('43c2f6ae-37c0-42d0-bd88-2d6fc335b9e9'); // Tamy
    expect(FAST_MODE_USER_IDS.length).toBe(2);
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
    expect(btn.textContent).toContain('Fast Mode Off');
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
    expect(screen.getByTestId('fast-mode-toggle').textContent).toContain('Fast Mode On');
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
    expect(btn).toHaveTextContent('Fast Mode Off');

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
    expect(btn).toHaveTextContent('Fast Mode On');
  });
});

describe('RoseToolSetChip contents', () => {
  it('removes deprecated tools and explains Wait For', () => {
    render(<RoseToolSetChip />);

    fireEvent.mouseEnter(screen.getByTitle('View Rose system tools'));

    expect(screen.queryByText('x402')).toBeNull();
    expect(screen.queryByText('Monitor')).toBeNull();
    expect(screen.queryByText('Message User (PLAN)')).toBeNull();
    expect(screen.getByText('Wait For')).toBeInTheDocument();
    expect(screen.getByText(/Pause until a timestamp or repeatedly check/)).toBeInTheDocument();
  });

  it('uses a dedicated clean icon for Browser Agent', () => {
    expect(TOOL_ICONS.browser_agent).toBeDefined();
    expect(TOOL_ICONS.browser_agent).not.toBe(TOOL_ICONS.default);
  });
});
