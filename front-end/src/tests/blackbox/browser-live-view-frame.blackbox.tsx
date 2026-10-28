/**
 * DOM contract: Steel live view is clipped to the 1280x800 content viewport.
 * Fails when the iframe is 16:9, framed as the 1288x891 chrome window, or
 * when a thumbnail is framed as 1440x900.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from './test-wrapper';

const mobileState = vi.hoisted(() => ({ value: false }));
vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => mobileState.value,
}));
vi.mock('@/features/terminal-component-group/components/MessageList', () => ({
  MessageList: () => <div data-testid="message-list" />,
}));
vi.mock('@/features/terminal-component-group/components/BrowserBorderGlow', () => ({
  default: () => null,
}));
vi.mock('@/features/terminal-component-group/components/BrowserCursorOverlay', () => ({
  default: () => null,
}));

import { BrowserAgentPane } from '@/features/terminal-component-group/components/browser-status-bar/BrowserAgentPane';
import { BrowserStatusBarExpanded } from '@/features/terminal-component-group/components/browser-status-bar/BrowserStatusBarExpanded';
import { LiveViewFrame } from '@/features/terminal-component-group/components/browser-status-bar/BrowserLiveViewFrame';
import {
  LIVE_VIEW_CONTENT_VIEWPORT,
  STEEL_LIVE_VIEW_WINDOW,
  steelLiveViewIframeCropStyle,
} from '@/features/terminal-component-group/components/browser-status-bar/liveViewDisplay';

const STEEL_PLAYER =
  'https://connect.steel.dev/v1/sessions/ef622b64-21ae-49c3-862b-b615e4ba9e52/player?interactive=false';
const BROWSER_USE_PLAYER = 'https://live.browser-use.com/session/browser-use-test';

function fullscreenProps() {
  return {
    agentId: 'agent-1',
    taskId: 't1',
    browserUrl: STEEL_PLAYER,
    messages: [],
    outputSchema: undefined,
    browserSessionMetadata: null,
    stepProgress: null,
    isDisconnected: false,
    isWaitingForAuthAssistance: false,
    isResuming: false,
    isUserControlling: false,
    pendingWriteLockApproval: null,
    onResume: vi.fn(),
  };
}

function expectSteelContentClip(stream: HTMLElement, iframe: HTMLElement) {
  const crop = steelLiveViewIframeCropStyle();
  expect(stream).toHaveClass('overflow-hidden');
  expect(stream).toHaveStyle({
    aspectRatio: `${LIVE_VIEW_CONTENT_VIEWPORT.width} / ${LIVE_VIEW_CONTENT_VIEWPORT.height}`,
  });
  expect(stream).not.toHaveStyle({
    aspectRatio: `${STEEL_LIVE_VIEW_WINDOW.width} / ${STEEL_LIVE_VIEW_WINDOW.height}`,
  });
  expect(iframe).toHaveStyle({
    width: crop.width,
    height: crop.height,
    left: crop.left,
    top: crop.top,
    transformOrigin: crop.transformOrigin,
    transform: crop.transform,
  });
}

describe('live-view iframe containment', () => {
  beforeEach(() => {
    mobileState.value = false;
  });

  it('crops Steel chrome in the drawer pane and does not resize the remote viewport', () => {
    renderWithProviders(<BrowserAgentPane {...fullscreenProps()} />);

    const iframe = screen.getByTitle('Browser');
    const pane = screen.getByTestId('live-view-pane');
    const stream = screen.getByTestId('live-view-stream');
    expect(pane).toHaveClass('overflow-hidden');
    expectSteelContentClip(stream, iframe);
  });

  it('renders the Kernel viewer at native 1280x800 scaled to the clip (its player never upscales)', () => {
    const rect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({
        width: 1920,
        height: 1200,
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 1920,
        bottom: 1200,
        toJSON: () => ({}),
      });
    try {
      renderWithProviders(
        <BrowserAgentPane
          {...fullscreenProps()}
          browserUrl="https://prod-iad-hypeman-25.kernel.sh/browser/live/abc?readOnly=true"
        />,
      );
      const iframe = screen.getByTitle('Browser');
      expect(iframe).toHaveStyle({ width: '1280px', height: '800px' });
      expect(iframe.style.transform).toBe('scale(1.5)');
      expect(iframe.style.transformOrigin).toBe('top left');
    } finally {
      rect.mockRestore();
    }
  });

  it('enables the drawer pane Browser Use viewer only during user control', () => {
    const props = { ...fullscreenProps(), browserUrl: BROWSER_USE_PLAYER };
    const { rerender } = renderWithProviders(<BrowserAgentPane {...props} />);
    expect(screen.getByTitle('Browser')).toHaveAttribute('inert');

    rerender(<BrowserAgentPane {...props} isUserControlling />);
    expect(screen.getByTitle('Browser')).not.toHaveAttribute('inert');
  });

  it('frames the expanded thumbnail to the cropped Steel content box, not 1440x900', () => {
    renderWithProviders(
      <BrowserStatusBarExpanded
        taskId="t1"
        browserUrl={STEEL_PLAYER}
        isDisconnected={false}
        isWaitingForAuthAssistance={false}
        outputSchema={undefined}
        browserSessionMetadata={null}
        stepProgress={null}
        onThumbnailClick={vi.fn()}
        onFullscreenToggle={vi.fn()}
        onCollapse={vi.fn()}
      />,
    );

    const iframe = screen.getByTitle('Preview');
    expect(iframe).toHaveAttribute('inert');
    expect(iframe).toHaveAttribute('tabindex', '-1');
    expect(iframe).not.toHaveStyle({ width: '1440px', height: '900px' });
    expect(iframe).toHaveStyle({
      width: `${STEEL_LIVE_VIEW_WINDOW.width}px`,
      height: `${STEEL_LIVE_VIEW_WINDOW.height}px`,
    });
    const transform = iframe.style.transform;
    expect(transform).toMatch(/scale\(/);
    expect(transform).toMatch(/translate\(/);
    const translateMatch = transform.match(/translate\(([-0-9.]+)px,\s*([-0-9.]+)px\)/);
    expect(translateMatch).not.toBeNull();
    expect(Number(translateMatch![2])).toBeLessThan(0);
  });

  it('does not recreate the Steel clip ResizeObserver when the same url rerenders', () => {
    let constructed = 0;
    const observe = vi.fn();
    const disconnect = vi.fn();
    const originalResizeObserver = window.ResizeObserver;
    window.ResizeObserver = class {
      observe = observe;
      disconnect = disconnect;
      constructor() {
        constructed += 1;
      }
    } as unknown as typeof ResizeObserver;

    const { rerender } = renderWithProviders(<LiveViewFrame url={STEEL_PLAYER} title="Browser" />);
    expect(constructed).toBe(1);

    rerender(<LiveViewFrame url={STEEL_PLAYER} title="Browser" iframeKey="rerender" />);
    expect(constructed).toBe(1);
    expect(disconnect).not.toHaveBeenCalled();

    window.ResizeObserver = originalResizeObserver;
  });
});
