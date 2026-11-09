/**
 * Rose Desktop left bar: dragging its right edge sets the expanded width and
 * pins it open (useSidebarExpansion). A pinned bar survives pointer-leave, the
 * Mac right-buffer auto-close and a remount; only Back or a drag to the rail
 * unpins it. Agent titles are never cut in JS, so a wider bar shows more text.
 * A pinned (or dragged-open) bar pushes the main content right by its width via
 * --rose-bar-offset; unpinned (collapsed or hover-expanded) the offset is 64px.
 * Full-width drawers start at that offset and right panels clamp so the chat
 * keeps CHAT_MIN_WIDTH. The drag captures the pointer and ends on pointerup,
 * lostpointercapture or window blur; only the primary button starts one.
 */
import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MainContent } from '@/features/terminal/components/TerminalMainContent';
import { BrowserStatusBarFullscreen } from '@/features/terminal-component-group/components/browser-status-bar/legacy/BrowserStatusBarFullscreen';
import { FullscreenView } from '@/features/terminal-component-group/components/claudeCodeChip.renderers';
import AppSidebar from '@/features/terminal-component-group/components/AppSidebar';
import { RoseAppIcons } from '@/features/terminal-component-group/components/rose-apps/RoseAppIcons';
import {
  CHAT_MIN_WIDTH,
  clampDrawerWidth,
  defaultDrawerWidth,
} from '@/features/terminal-component-group/components/rose-apps/roseAppsLayout';

import { defaultProps, makeAgent } from './app-sidebar.fixtures';
import { resolvedLeft } from './rose-sidebar.fixtures';
import { renderWithProviders } from './test-wrapper';

// The browser full screen's transcript needs an AgentProvider; only its frame is under test.
vi.mock('@/features/terminal-component-group/components/MessageList', () => ({
  MessageList: () => <div data-testid="message-list" />,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const bar = () => screen.getByTestId('rose-sidebar');
const barWidth = () => Number.parseInt(bar().style.width, 10);
const handle = () => screen.getByTestId('rose-sidebar-resize-handle');

/** The sidebar beside the real main column (network view keeps the column light). */
function mainContentProps(sidebarWidthCollapsed = 64) {
  return {
    agents: { clientSource: 'WEB', isAuthenticated: true, isAnonymous: false },
    currentView: 'network',
    NetworkView: () => <div>network</div>,
    sidebarWidthCollapsed,
  } as unknown as React.ComponentProps<typeof MainContent>;
}

function renderShell() {
  return renderWithProviders(
    <>
      <AppSidebar {...defaultProps()} />
      <MainContent {...mainContentProps()} />
      <RoseAppIcons />
    </>,
  );
}

/** pointerdown on the handle and one move, leaving the drag open. */
function startDrag(clientX: number, init: { button?: number; pointerId?: number } = {}) {
  act(() => {
    fireEvent.pointerDown(handle(), init);
  });
  act(() => {
    fireEvent.pointerMove(window, { clientX });
  });
}

/** The left offset the main column pads by (md+), resolved from the root var it reads. */
function mainOffset(): string {
  expect(screen.getByTestId('terminal-main-content')).toHaveClass(
    'md:pl-[var(--rose-bar-offset,64px)]',
  );
  return document.documentElement.style.getPropertyValue('--rose-bar-offset');
}

function stubPlatform(platform: string, innerWidth = 1440) {
  vi.stubGlobal('navigator', Object.create(navigator, { platform: { value: platform } }));
  vi.stubGlobal('innerWidth', innerWidth);
}

/** pointerdown on the handle, then move/release on window (separate commits, like real frames). */
function drag(clientX: number) {
  act(() => {
    fireEvent.pointerDown(handle());
  });
  act(() => {
    fireEvent.pointerMove(window, { clientX });
  });
  act(() => {
    fireEvent.pointerUp(window, { clientX });
  });
}

describe('Rose sidebar resize handle', () => {
  it.each(['MacIntel', 'Linux x86_64'])(
    'drag widens the bar and pins it open on %s: no auto-close on leave or far-right movement',
    (platform) => {
      stubPlatform(platform);
      renderWithProviders(<AppSidebar {...defaultProps()} />);
      expect(handle()).toHaveClass('cursor-col-resize');
      expect(barWidth()).toBe(64);

      drag(420);
      expect(barWidth()).toBe(420);
      expect(bar()).toHaveAttribute('data-expanded', 'true');
      expect(bar()).toHaveAttribute('data-pinned', 'true');

      fireEvent.mouseLeave(bar());
      fireEvent.mouseMove(window, { clientX: 1400 });
      expect(bar()).toHaveAttribute('data-expanded', 'true');
      expect(barWidth()).toBe(420);
    },
  );

  it('a reload with the bar pinned sizes a right panel from the pinned offset', async () => {
    // The bar publishes its offset in a layout effect before RoseApps listens:
    // without reading it at mount, panels clamp against 64px and crush the chat.
    stubPlatform('Linux x86_64', 1200);
    const first = renderShell();
    drag(560);
    first.unmount();
    renderShell();
    expect(mainOffset()).toBe('560px');
    await userEvent.setup().click(screen.getByTestId('rose-app-integrations'));
    const panel = screen.getByTestId('rose-app-panel');
    const expected = clampDrawerWidth(defaultDrawerWidth(1200, 560), 1200, 560);
    expect(expected).toBeLessThan(clampDrawerWidth(defaultDrawerWidth(1200, 64), 1200, 64));
    expect(Number.parseInt(panel.style.width, 10)).toBe(expected);
  });

  it('persists width and pin across a remount', () => {
    stubPlatform('Linux x86_64');
    const first = renderWithProviders(<AppSidebar {...defaultProps()} />);
    drag(380);
    first.unmount();

    renderWithProviders(<AppSidebar {...defaultProps()} />);
    expect(bar()).toHaveAttribute('data-expanded', 'true');
    expect(barWidth()).toBe(380);
  });

  it.each([
    [1440, 560],
    [800, 400],
  ])('clamps to min(560, half of a %ipx window) and never below 236', (innerWidth, max) => {
    stubPlatform('Linux x86_64', innerWidth);
    renderWithProviders(<AppSidebar {...defaultProps()} />);
    drag(5000);
    expect(barWidth()).toBe(max);
    drag(180);
    expect(barWidth()).toBe(236);
  });

  it('dragging to the rail or pressing Back unpins and collapses', () => {
    stubPlatform('Linux x86_64');
    renderWithProviders(<AppSidebar {...defaultProps()} />);
    drag(400);
    drag(40);
    expect(bar()).toHaveAttribute('data-expanded', 'false');
    expect(bar()).toHaveAttribute('data-pinned', 'false');
    expect(barWidth()).toBe(64);

    drag(400);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(bar()).toHaveAttribute('data-expanded', 'false');
    expect(localStorage.getItem('rose-sidebar-pinned')).toBe('false');
    // The dragged width is remembered for the next expansion.
    fireEvent.mouseLeave(bar());
    fireEvent.mouseEnter(bar());
    expect(barWidth()).toBe(400);
  });

  it.each(['MacIntel', 'Linux x86_64'])(
    'pinned width pushes the main content on %s; unpinned or hover-expanded it is 64px',
    (platform) => {
      stubPlatform(platform);
      const view = renderShell();
      expect(mainOffset()).toBe('64px');

      fireEvent.mouseEnter(bar());
      expect(bar()).toHaveAttribute('data-expanded', 'true');
      expect(mainOffset()).toBe('64px');
      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      fireEvent.mouseLeave(bar());

      act(() => {
        fireEvent.pointerDown(handle());
      });
      act(() => {
        fireEvent.pointerMove(window, { clientX: 300 });
      });
      expect(mainOffset()).toBe('300px');
      act(() => {
        fireEvent.pointerMove(window, { clientX: 420 });
      });
      act(() => {
        fireEvent.pointerUp(window, { clientX: 420 });
      });
      expect(mainOffset()).toBe('420px');

      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      expect(mainOffset()).toBe('64px');

      drag(400);
      expect(mainOffset()).toBe('400px');
      drag(40);
      expect(mainOffset()).toBe('64px');

      view.unmount();
      expect(document.documentElement.style.getPropertyValue('--rose-bar-offset')).toBe('');
    },
  );

  it('re-clamps the pinned width and content offset on a live window resize', () => {
    stubPlatform('Linux x86_64', 1440);
    renderShell();
    drag(540);
    expect(barWidth()).toBe(540);
    act(() => {
      vi.stubGlobal('innerWidth', 800);
      window.dispatchEvent(new Event('resize'));
    });
    expect(barWidth()).toBe(400);
    expect(mainOffset()).toBe('400px');
    // The saved preference is kept, so widening the window restores it.
    act(() => {
      vi.stubGlobal('innerWidth', 1440);
      window.dispatchEvent(new Event('resize'));
    });
    expect(barWidth()).toBe(540);
    expect(mainOffset()).toBe('540px');
  });

  it('pinned bar moves the full drawer left edge; right panels keep the chat minimum', async () => {
    stubPlatform('Linux x86_64', 1440);
    const user = userEvent.setup();
    renderShell();
    drag(560);
    expect(mainOffset()).toBe('560px');

    await user.click(screen.getByTestId('rose-app-browser'));
    const full = screen.getByTestId('browser-app-drawer');
    expect(full).toHaveAttribute('data-variant', 'full');
    expect(resolvedLeft(full)).toBe('560px');

    // Pure clamp: the live offset replaces the 64px rail.
    expect(clampDrawerWidth(5000, 1440, 560)).toBe(1440 - 560 - CHAT_MIN_WIDTH);
    expect(clampDrawerWidth(5000, 1440)).toBe(1440 - 64 - CHAT_MIN_WIDTH);

    await user.click(screen.getByTestId('rose-app-integrations'));
    const panel = screen.getByTestId('rose-app-panel');
    const panelHandle = within(panel).getByTestId('app-drawer-resize-handle');
    fireEvent.pointerDown(panelHandle, { clientX: 900 });
    fireEvent.pointerMove(window, { clientX: 0 });
    fireEvent.pointerUp(window);
    const panelWidth = Number.parseInt(panel.style.width, 10);
    expect(panelWidth).toBe(1440 - 560 - CHAT_MIN_WIDTH);
    expect(1440 - 560 - panelWidth).toBe(CHAT_MIN_WIDTH);

    // Unpinning gives the room back to the panel's clamp and the full drawer's edge.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(resolvedLeft(full)).toBe('64px');
    fireEvent.pointerDown(panelHandle, { clientX: 900 });
    fireEvent.pointerMove(window, { clientX: 0 });
    fireEvent.pointerUp(window);
    expect(Number.parseInt(panel.style.width, 10)).toBe(1440 - 64 - CHAT_MIN_WIDTH);
  });

  it('full-screen code and browser views start at the pinned bar offset, not under it', () => {
    stubPlatform('Linux x86_64', 1440);
    renderWithProviders(
      <>
        <AppSidebar {...defaultProps()} />
        <FullscreenView
          state="completed"
          outputSchema={undefined}
          githubRepoUrl={undefined}
          codeProvider="claude"
          terminalTranscript=""
          terminalContainerRef={{ current: null }}
          onClose={vi.fn()}
        />
        <BrowserStatusBarFullscreen
          agentId="agent-1"
          taskId="task-1"
          browserUrl="https://live.browser-use.com/session/test"
          messages={[]}
          outputSchema={undefined}
          browserSessionMetadata={null}
          stepProgress={null}
          isDisconnected={false}
          isWaitingForAuthAssistance={false}
          isResuming={false}
          isUserControlling={false}
          pendingWriteLockApproval={null}
          onClose={vi.fn()}
          onResume={vi.fn()}
        />
      </>,
    );
    const offsetClass = 'md:left-[var(--rose-bar-offset,0px)]';
    expect(screen.getByTestId('code-agent-fullscreen')).toHaveClass(offsetClass);
    expect(screen.getByTestId('browser-desktop-fullscreen')).toHaveClass(offsetClass);
    expect(document.documentElement.style.getPropertyValue('--rose-bar-offset')).toBe('64px');
    drag(560);
    expect(document.documentElement.style.getPropertyValue('--rose-bar-offset')).toBe('560px');
  });

  it('does not pad the main content when the layout has no bar', () => {
    stubPlatform('Linux x86_64');
    renderWithProviders(<MainContent {...mainContentProps(0)} />);
    expect(screen.getByTestId('terminal-main-content').className).not.toContain(
      '--rose-bar-offset',
    );
  });

  it('captures the pointer, keeps col-resize on the body, and ends on pointerup', () => {
    stubPlatform('Linux x86_64');
    renderWithProviders(<AppSidebar {...defaultProps()} />);
    const setPointerCapture = vi.fn();
    Object.assign(handle(), { setPointerCapture });
    startDrag(380, { pointerId: 7 });
    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(document.body.style.cursor).toBe('col-resize');
    expect(document.body.style.userSelect).toBe('none');
    act(() => {
      fireEvent.pointerUp(window, { clientX: 380 });
    });
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
    expect(barWidth()).toBe(380);
  });

  it.each([
    ['window blur', () => fireEvent.blur(window)],
    ['lostpointercapture', () => fireEvent(handle(), new Event('lostpointercapture'))],
  ])('%s mid-drag ends the drag (pinned at the last width)', (_name, end) => {
    stubPlatform('Linux x86_64');
    renderWithProviders(<AppSidebar {...defaultProps()} />);
    startDrag(400);
    expect(document.body.style.cursor).toBe('col-resize');
    act(() => {
      end();
    });
    expect(bar()).toHaveAttribute('data-pinned', 'true');
    expect(barWidth()).toBe(400);
    expect(document.body.style.cursor).toBe('');
    // No longer dragging: later moves do nothing.
    act(() => {
      fireEvent.pointerMove(window, { clientX: 500 });
    });
    expect(barWidth()).toBe(400);
  });

  it('right-click on the handle does not start a drag', () => {
    stubPlatform('Linux x86_64');
    renderWithProviders(<AppSidebar {...defaultProps()} />);
    startDrag(400, { button: 2 });
    act(() => {
      fireEvent.pointerUp(window, { clientX: 400 });
    });
    expect(bar()).toHaveAttribute('data-pinned', 'false');
    expect(barWidth()).toBe(64);
    expect(document.body.style.cursor).toBe('');
  });

  it('exposes the handle range to assistive tech', () => {
    stubPlatform('Linux x86_64', 1440);
    renderWithProviders(<AppSidebar {...defaultProps()} />);
    expect(handle()).toHaveAttribute('aria-valuemin', '236');
    expect(handle()).toHaveAttribute('aria-valuemax', '560');
    expect(handle()).toHaveAttribute('aria-valuenow', '236');
  });

  it('arrow keys on the focused handle resize by 16px and pin', () => {
    stubPlatform('Linux x86_64');
    renderWithProviders(<AppSidebar {...defaultProps()} />);
    fireEvent.keyDown(handle(), { key: 'ArrowRight' });
    expect(barWidth()).toBe(252);
    expect(bar()).toHaveAttribute('data-pinned', 'true');
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' });
    expect(barWidth()).toBe(236);
  });

  it('renders full agent titles (CSS ellipsis only, no JS character cap)', () => {
    stubPlatform('Linux x86_64');
    const longGoal =
      'Update the card border removal across every Rose desktop surface, then verify the result in the published UI sandbox';
    const longTitle = 'Lemon Dopamine Meetings And Cancellation Follow-ups For The Whole Week';
    renderWithProviders(
      <AppSidebar
        {...defaultProps({
          agents: [
            makeAgent({ agent_id: 'goal-only', goal: longGoal }),
            makeAgent({ agent_id: 'titled', goal: 'x', title: longTitle }),
          ],
        })}
      />,
    );
    drag(560);
    const goalRow = screen.getByTestId('rose-agent-row-goal-only');
    const titledRow = screen.getByTestId('rose-agent-row-titled');
    expect(goalRow).toHaveTextContent(longGoal);
    expect(titledRow).toHaveTextContent(longTitle);
    expect(goalRow.textContent).not.toContain('…');
    expect(titledRow.querySelector('.truncate')).toHaveTextContent(longTitle);
  });
});
