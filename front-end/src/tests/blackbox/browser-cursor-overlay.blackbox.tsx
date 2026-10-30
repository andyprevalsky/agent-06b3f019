/**
 * Blackbox tests for BrowserCursorOverlay realtime cursor routing, page->stream
 * alignment across pane sizes, and the stable (never-restarted) glide + bob.
 */
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Message } from '@/lib/api';
import { server } from './msw/server';

const realtimeMocks = vi.hoisted(() => ({
  subscribeToChannel: vi.fn(),
  unsubscribe: vi.fn(),
  extractRecord: vi.fn((wrapper: unknown) => {
    return (wrapper as { payload?: { record?: unknown } }).payload?.record ?? null;
  }),
}));

vi.mock('@/lib/realtime', () => ({
  subscribeToChannel: realtimeMocks.subscribeToChannel,
  unsubscribe: realtimeMocks.unsubscribe,
  extractRecord: realtimeMocks.extractRecord,
}));

import BrowserCursorOverlay from '@/features/terminal-component-group/components/BrowserCursorOverlay';
import { useRefreshedAuthAssistanceUrl } from '@/features/terminal-component-group/components/browser-status-bar/useRefreshedAuthAssistanceUrl';
import type { PendingAuthAssistance } from '@/features/terminal-component-group/components/browser-status-bar/types';
import {
  KERNEL_PAGE_OFFSET,
  computeLiveViewLetterbox,
  kernelLiveViewScaledStyle,
  presentLiveViewIframeUrl,
  resolveLiveViewPageRect,
} from '@/features/terminal-component-group/components/browser-status-bar/liveViewDisplay';

const API_BASE = 'http://localhost:3001/api';

function makeMessageWithCoords(x: number, y: number): Message {
  return {
    message_id: 'message-with-coords',
    timestamp: '2026-05-29T12:00:00Z',
    text: 'Clicked',
    role: 'TOOL',
    metadata: {
      task_id: 'task-1',
      auxiliary: { coordinates: { x, y } },
    },
  };
}

const KERNEL_URL = 'https://prod-iad-hypeman-25.kernel.sh/browser/live/abc?readOnly=true';
const STEEL_URL = 'https://api.steel.dev/v1/sessions/s/player';

type CursorHandlers = Record<string, (payload: unknown) => void>;

function sample(x: number, y: number, sequence: number, agentId = 'agent-1') {
  return { payload: { record: { agentId, taskId: 'task-1', x, y, sequence } } };
}

function trackTranslate(): { x: number; y: number } {
  const transform = screen.getByTestId('browser-cursor-track').style.transform;
  const match = transform.match(/translate\(([-0-9.]+)%,\s*([-0-9.]+)%\)/);
  if (!match) throw new Error(`unexpected cursor transform: ${transform}`);
  return { x: Number(match[1]), y: Number(match[2]) };
}

/** Pane pixel where the overlay puts the cursor tip (overlay box = letterboxed display box). */
function overlayTipPixel(paneWidth: number, paneHeight: number, display: { w: number; h: number }) {
  const box = computeLiveViewLetterbox(paneWidth, paneHeight, display.w, display.h);
  const t = trackTranslate();
  return { x: box.offsetX + (t.x / 100) * box.width, y: box.offsetY + (t.y / 100) * box.height };
}

/**
 * Ground truth measured on live sessions (2026-10-28): marks painted at known
 * page coordinates were located in each provider's stream. Each function
 * returns the pane pixel where the provider paints page point (x, y) inside the
 * FE's letterboxed box, independent of the production geometry table.
 */
const PROVIDER_TRUTH = {
  // Whole 1280x800 headful screen shown; Chrome UI fills the top 87px.
  kernel: {
    url: 'https://prod-iad-hypeman-25.kernel.sh/browser/live/abc?readOnly=true',
    display: { w: 1280, h: 800 },
    paint: (box: ReturnType<typeof computeLiveViewLetterbox>, x: number, y: number) => ({
      x: box.offsetX + x * box.scale,
      y: box.offsetY + (y + 87) * box.scale,
    }),
  },
  // 1288x891 window cropped to the page at (4, 87): the box shows exactly the page.
  steel: {
    url: 'https://api.steel.dev/v1/sessions/s/player?interactive=false',
    display: { w: 1280, h: 800 },
    paint: (box: ReturnType<typeof computeLiveViewLetterbox>, x: number, y: number) => ({
      x: box.offsetX + x * box.scale,
      y: box.offsetY + y * box.scale,
    }),
  },
  // embed=1 viewer: the 1366x625 page image object-fit:contain, anchored top-left.
  tilion: {
    url: 'https://back.tilion.dev/v1/session/sess_x/live-view?token=t',
    display: { w: 1366, h: 625 },
    paint: (box: ReturnType<typeof computeLiveViewLetterbox>, x: number, y: number) => {
      const s = Math.min(box.width / 1366, box.height / 625);
      return { x: box.offsetX + x * s, y: box.offsetY + y * s };
    },
  },
} as const;

async function renderWithHandlers(
  props: Partial<React.ComponentProps<typeof BrowserCursorOverlay>> = {},
) {
  const view = render(
    <BrowserCursorOverlay agentId="agent-1" taskId="task-1" messages={[]} {...props} />,
  );
  await waitFor(() => expect(realtimeMocks.subscribeToChannel).toHaveBeenCalled());
  const handlers = realtimeMocks.subscribeToChannel.mock.calls[0][1] as CursorHandlers;
  return { view, handlers };
}

describe('BrowserCursorOverlay realtime stream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    realtimeMocks.subscribeToChannel.mockResolvedValue({ topic: 'agent:agent-1' });
    localStorage.setItem(
      'rose-session',
      JSON.stringify({ access_token: 'test-token', user: { id: 'test-user' } }),
    );
  });

  it('subscribes to BROWSER_CURSOR and targets the live sample', async () => {
    const { handlers } = await renderWithHandlers();
    act(() => handlers.BROWSER_CURSOR(sample(320, 200, 1)));
    expect(trackTranslate()).toEqual({ x: 25, y: 25 });
    const track = screen.getByTestId('browser-cursor-track');
    expect(track).toHaveAttribute('data-cursor-x', '320');
    expect(track).toHaveAttribute('data-cursor-y', '200');
  });

  it('glides with one stable CSS-transitioned track and never remounts the bobbing cursor', async () => {
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame');
    try {
      const { view, handlers } = await renderWithHandlers({ browserUrl: KERNEL_URL });
      const track = screen.getByTestId('browser-cursor-track');
      const cursor = screen.getByTestId('browser-cursor');
      expect(track).toHaveClass('browser-cursor-track');
      expect(cursor).toHaveClass('browser-cursor-bob');
      const cursorStyle = cursor.getAttribute('style');

      for (let i = 1; i <= 12; i += 1) {
        act(() => handlers.BROWSER_CURSOR(sample(100 + i * 40, 100 + i * 20, i)));
      }
      view.rerender(
        <BrowserCursorOverlay
          agentId="agent-1"
          taskId="task-1"
          messages={[makeMessageWithCoords(900, 500)]}
          browserUrl={KERNEL_URL}
        />,
      );
      view.rerender(
        <BrowserCursorOverlay
          agentId="agent-1"
          taskId="task-1"
          messages={[makeMessageWithCoords(900, 500)]}
          browserUrl={KERNEL_URL}
          visible={false}
        />,
      );
      view.rerender(
        <BrowserCursorOverlay
          agentId="agent-1"
          taskId="task-1"
          messages={[makeMessageWithCoords(900, 500)]}
          browserUrl={KERNEL_URL}
          visible
        />,
      );

      // Same DOM nodes: the bob animation element was never recreated, its
      // class/inline style never changed, so its CSS animation cannot restart.
      expect(screen.getByTestId('browser-cursor-track')).toBe(track);
      expect(screen.getByTestId('browser-cursor')).toBe(cursor);
      expect(cursor).toHaveClass('browser-cursor-bob');
      expect(cursor.getAttribute('style')).toBe(cursorStyle);
      // A late-saved action message never pulls a live-streaming cursor back.
      expect(track).toHaveAttribute('data-cursor-x', '580');
      // Motion is a CSS transition on the track, not a per-sample RAF loop.
      expect(rafSpy).not.toHaveBeenCalled();
    } finally {
      rafSpy.mockRestore();
    }
  });

  it('ignores a realtime sample delivered out of order', async () => {
    const { handlers } = await renderWithHandlers();
    const stamped = (x: number, y: number, timestampMs: number) => ({
      payload: { record: { agentId: 'agent-1', taskId: 'task-1', x, y, timestampMs } },
    });
    act(() => handlers.BROWSER_CURSOR(stamped(640, 400, 2000)));
    act(() => handlers.BROWSER_CURSOR(stamped(128, 80, 1500)));
    expect(trackTranslate()).toEqual({ x: 50, y: 50 });
    act(() => handlers.BROWSER_CURSOR(stamped(128, 80, 2033)));
    expect(trackTranslate()).toEqual({ x: 10, y: 10 });
  });

  it('hides without unmounting while the agent is not driving', async () => {
    const { view } = await renderWithHandlers({ visible: false });
    expect(screen.getByTestId('browser-cursor-overlay')).toHaveStyle({ visibility: 'hidden' });
    view.rerender(<BrowserCursorOverlay agentId="agent-1" taskId="task-1" messages={[]} visible />);
    expect(screen.getByTestId('browser-cursor-overlay')).toHaveStyle({ visibility: 'visible' });
    expect(realtimeMocks.subscribeToChannel).toHaveBeenCalledTimes(1);
  });

  it('keeps saved message coordinates as a fallback when realtime is unavailable', () => {
    render(
      <BrowserCursorOverlay
        agentId={null}
        taskId="task-1"
        messages={[makeMessageWithCoords(128, 80)]}
      />,
    );
    expect(trackTranslate()).toEqual({ x: 10, y: 10 });
    expect(realtimeMocks.subscribeToChannel).not.toHaveBeenCalled();
  });

  it('cannot apply a queued cursor callback after switching agents', async () => {
    const view = render(<BrowserCursorOverlay agentId="agent-a" taskId="task-1" messages={[]} />);
    await waitFor(() => expect(realtimeMocks.subscribeToChannel).toHaveBeenCalledTimes(1));
    const staleHandlers = realtimeMocks.subscribeToChannel.mock.calls[0][1] as CursorHandlers;

    view.rerender(<BrowserCursorOverlay agentId="agent-b" taskId="task-1" messages={[]} />);
    await waitFor(() => expect(realtimeMocks.subscribeToChannel).toHaveBeenCalledTimes(2));
    act(() => staleHandlers.BROWSER_CURSOR(sample(10, 20, 2, 'agent-a')));

    expect(trackTranslate()).toEqual({ x: 50, y: 50 });
  });

  it('rejects a cursor payload whose agent identity differs from its channel', async () => {
    const { handlers } = await renderWithHandlers();
    act(() => handlers.BROWSER_CURSOR(sample(10, 20, 1, 'other-agent')));
    expect(trackTranslate()).toEqual({ x: 50, y: 50 });
  });

  it('maps Steel (chrome-cropped) page coordinates straight onto the content box', () => {
    render(
      <BrowserCursorOverlay
        agentId={null}
        taskId="task-1"
        messages={[makeMessageWithCoords(0, 0)]}
        browserUrl={STEEL_URL}
      />,
    );
    expect(trackTranslate()).toEqual({ x: 0, y: 0 });
  });

  it.each(['kernel', 'steel', 'tilion'] as const)(
    'lands on the %s-painted page point at every pane size, letterbox and DPR',
    (provider) => {
      const truth = PROVIDER_TRUTH[provider];
      const page = { x: 1000, y: 600 };
      render(
        <BrowserCursorOverlay
          agentId={null}
          taskId="task-1"
          messages={[makeMessageWithCoords(page.x, page.y)]}
          browserUrl={truth.url}
        />,
      );
      // Pane sizes in CSS px: native, shrunk, enlarged past native, pillarboxed
      // (wide) and letterboxed (tall). DPR does not enter: the overlay and the
      // scaled iframe both live in CSS px (checked at DPR 1 and 2 in Chromium).
      const panes: Array<[number, number]> = [
        [1280, 800],
        [960, 600],
        [2560, 1600],
        [1920, 900],
        [700, 1100],
        [1111, 777],
      ];
      for (const [w, h] of panes) {
        const box = computeLiveViewLetterbox(w, h, truth.display.w, truth.display.h);
        const tip = overlayTipPixel(w, h, truth.display);
        const painted = truth.paint(box, page.x, page.y);
        expect(tip.x).toBeCloseTo(painted.x, 6);
        expect(tip.y).toBeCloseTo(painted.y, 6);
      }
    },
  );

  it('binds geometry per provider, never one offset for all', () => {
    expect(resolveLiveViewPageRect(PROVIDER_TRUTH.kernel.url)).toEqual({
      x: 0,
      y: 87,
      width: 1280,
      height: 713,
    });
    expect(resolveLiveViewPageRect(PROVIDER_TRUTH.steel.url)).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 800,
    });
    expect(resolveLiveViewPageRect(PROVIDER_TRUTH.tilion.url)).toEqual({
      x: 0,
      y: 0,
      width: 1366,
      height: 625,
    });
    expect(KERNEL_PAGE_OFFSET).toEqual({ x: 0, y: 87 });
    expect(presentLiveViewIframeUrl(PROVIDER_TRUTH.tilion.url)).toContain('embed=1');
    expect(presentLiveViewIframeUrl(PROVIDER_TRUTH.kernel.url)).toBe(PROVIDER_TRUTH.kernel.url);
  });

  it('renders the Kernel iframe at native pixels scaled to the clip so the stream fills it', () => {
    expect(kernelLiveViewScaledStyle(2560)).toMatchObject({
      width: '1280px',
      height: '800px',
      transformOrigin: 'top left',
      transform: 'scale(2)',
    });
    expect(kernelLiveViewScaledStyle(640).transform).toBe('scale(0.5)');
  });
});

describe('browser auth URL isolation', () => {
  it('never renders the previous request URL during a browser-agent switch', async () => {
    let finishAgentA!: () => void;
    const agentACanFinish = new Promise<void>((resolve) => {
      finishAgentA = resolve;
    });
    server.use(
      http.post(`${API_BASE}/auth-assistance/:requestId/refresh-session`, async ({ params }) => {
        const requestId = String(params.requestId);
        if (requestId === 'request-a') await agentACanFinish;
        return HttpResponse.json({ liveViewUrl: `https://${requestId}.example/live` });
      }),
    );
    const requestA: PendingAuthAssistance = {
      requestId: 'request-a',
      request: 'Authenticate A',
      liveViewUrl: 'https://agent-a.example/live',
    };
    const requestB: PendingAuthAssistance = {
      requestId: 'request-b',
      request: 'Authenticate B',
      liveViewUrl: 'https://agent-b.example/live',
    };
    const rendered: Array<{ requestId: string; url: string | null }> = [];
    function UrlProbe({ request }: { request: PendingAuthAssistance }) {
      const url = useRefreshedAuthAssistanceUrl(request);
      rendered.push({ requestId: request.requestId, url });
      return <output data-testid="auth-url">{url}</output>;
    }

    const view = render(<UrlProbe request={requestA} />);
    view.rerender(<UrlProbe request={requestB} />);

    expect(rendered.filter((entry) => entry.requestId === 'request-b')).not.toContainEqual({
      requestId: 'request-b',
      url: requestA.liveViewUrl,
    });
    expect(screen.getByTestId('auth-url')).toHaveTextContent('agent-b');
    finishAgentA();
    await waitFor(() => expect(screen.getByTestId('auth-url')).toHaveTextContent('request-b'));
  });
});
